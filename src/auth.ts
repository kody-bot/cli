import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import {
	auth,
	type OAuthClientInformationMixed,
	type OAuthTokens,
} from '@modelcontextprotocol/client'
import {
	accessTokenSkewMs,
	cliRedirectUrl,
	defaultMcpUrl,
	defaultScopes,
	loginTimeoutMs,
} from './defaults.js'
import { createCliOAuthProvider } from './oauth-provider.js'
import { redactError } from './redact.js'
import {
	loadCredentials,
	saveCredentials,
	type SecretBackend,
	type StoredCredentials,
} from './store.js'

export type LoginOptions = {
	mcpUrl?: string
	openBrowser?: boolean
	backend?: SecretBackend
	timeoutMs?: number
	now?: () => number
	fetchFn?: typeof fetch
	onAuthorizationUrl?: (url: URL) => void
}

export function isAccessTokenExpired(
	credentials: StoredCredentials,
	now: number = Date.now(),
): boolean {
	if (!credentials.expiresAt) return false
	return now + accessTokenSkewMs >= credentials.expiresAt
}

export function credentialsFromTokens(input: {
	mcpUrl: string
	resource: string
	authorizationServerUrl: string
	client: OAuthClientInformationMixed
	tokens: OAuthTokens
	previous?: StoredCredentials
	now?: number
}): StoredCredentials {
	const now = input.now ?? Date.now()
	const expiresAt =
		typeof input.tokens.expires_in === 'number'
			? now + input.tokens.expires_in * 1000
			: input.previous?.expiresAt
	return {
		version: 1,
		mcpUrl: input.mcpUrl,
		resource: input.resource,
		authorizationServerUrl: input.authorizationServerUrl,
		clientId: input.client.client_id,
		clientSecret:
			'client_secret' in input.client
				? input.client.client_secret
				: input.previous?.clientSecret,
		accessToken: input.tokens.access_token,
		refreshToken: input.tokens.refresh_token ?? input.previous?.refreshToken,
		tokenType: input.tokens.token_type ?? 'bearer',
		expiresAt,
		scope: input.tokens.scope ?? input.previous?.scope,
	}
}

async function persistAuthorizedSession(input: {
	mcpUrl: string
	provider: ReturnType<typeof createCliOAuthProvider>
	backend?: SecretBackend
	previous?: StoredCredentials
	now?: number
}): Promise<{
	credentials: StoredCredentials
	saved: ReturnType<typeof saveCredentials>
}> {
	const tokens = await input.provider.tokens()
	const client = await input.provider.clientInformation()
	if (!tokens || !client) {
		throw new Error('OAuth completed without tokens. Run `kody login`.')
	}
	const credentials = credentialsFromTokens({
		mcpUrl: input.mcpUrl,
		resource: input.mcpUrl,
		authorizationServerUrl:
			tokens.issuer ??
			input.previous?.authorizationServerUrl ??
			new URL(input.mcpUrl).origin,
		client,
		tokens,
		previous: input.previous,
		now: input.now,
	})
	const saved = saveCredentials(credentials, input.backend)
	return { credentials, saved }
}

export async function refreshStoredCredentials(input: {
	credentials: StoredCredentials
	backend?: SecretBackend
	now?: number
	fetchFn?: typeof fetch
}): Promise<StoredCredentials> {
	const { credentials } = input
	if (!credentials.refreshToken) {
		throw new Error('No refresh token is stored. Run `kody login`.')
	}
	const provider = createCliOAuthProvider({
		mcpUrl: credentials.mcpUrl,
		redirectUri: cliRedirectUrl(),
		existing: credentials,
		loadStoredTokens: true,
		openBrowser: false,
		expectedState: crypto.randomUUID(),
	})
	const result = await auth(provider, {
		serverUrl: credentials.mcpUrl,
		scope: defaultScopes.join(' '),
		fetchFn: input.fetchFn,
	})
	if (result !== 'AUTHORIZED') {
		throw new Error('Token refresh requires a new `kody login`.')
	}
	const { credentials: next } = await persistAuthorizedSession({
		mcpUrl: credentials.mcpUrl,
		provider,
		backend: input.backend,
		previous: credentials,
		now: input.now,
	})
	return next
}

export async function ensureFreshCredentials(input: {
	mcpUrl?: string
	backend?: SecretBackend
	now?: number
	fetchFn?: typeof fetch
}): Promise<StoredCredentials> {
	const mcpUrl = input.mcpUrl ?? defaultMcpUrl
	const credentials = loadCredentials(mcpUrl, input.backend)
	if (!credentials) {
		throw new Error('Not logged in. Run `kody login`.')
	}
	if (!isAccessTokenExpired(credentials, input.now)) {
		return credentials
	}
	return await refreshStoredCredentials({
		credentials,
		backend: input.backend,
		now: input.now,
		fetchFn: input.fetchFn,
	})
}

function startCallbackServer(redirectUri: URL): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		const port = Number(redirectUri.port)
		server.listen(port, redirectUri.hostname, () => resolve(server))
		server.on('error', (error) => {
			if ('code' in error && error.code === 'EADDRINUSE') {
				reject(
					new Error(
						`Login callback port ${port} is in use. Stop the other listener and retry.`,
					),
				)
				return
			}
			reject(error)
		})
	})
}

function waitForCallback(input: {
	server: Server
	redirectUri: URL
	expectedState: string
	timeoutMs: number
}): Promise<{ code: string; iss?: string }> {
	return new Promise((resolve, reject) => {
		const finish = (error: Error | null, result?: { code: string; iss?: string }) => {
			clearTimeout(timer)
			input.server.close()
			if (error) reject(error)
			else resolve(result ?? { code: '' })
		}
		const timer = setTimeout(() => {
			finish(new Error('Timed out waiting for the browser login.'))
		}, input.timeoutMs)

		input.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
			try {
				const url = new URL(request.url ?? '/', input.redirectUri)
				if (url.pathname !== input.redirectUri.pathname) {
					response.writeHead(404).end('Not found')
					return
				}
				const error = url.searchParams.get('error')
				if (error) {
					const description = url.searchParams.get('error_description') ?? ''
					response
						.writeHead(400, { 'Content-Type': 'text/html' })
						.end('<p>Authorization failed. You can close this window.</p>')
					finish(new Error(description || error))
					return
				}
				const state = url.searchParams.get('state')
				const code = url.searchParams.get('code')
				const iss = url.searchParams.get('iss') ?? undefined
				if (state !== input.expectedState || !code) {
					response
						.writeHead(400, { 'Content-Type': 'text/html' })
						.end('<p>Invalid OAuth callback. You can close this window.</p>')
					finish(new Error('OAuth callback missing code or state.'))
					return
				}
				response
					.writeHead(200, { 'Content-Type': 'text/html' })
					.end('<p>Kody CLI is signed in. You can close this window.</p>')
				finish(null, { code, ...(iss ? { iss } : {}) })
			} catch (error) {
				finish(redactError(error))
			}
		})
	})
}

export async function login(options: LoginOptions = {}): Promise<{
	credentials: StoredCredentials
	authorizationUrl: URL
	backendKind: 'keyring' | 'file'
	backendPath?: string
}> {
	const mcpUrl = options.mcpUrl ?? defaultMcpUrl
	const redirectUri = cliRedirectUrl()
	const expectedState = crypto.randomUUID()
	const server = await startCallbackServer(redirectUri)
	let authorizationUrl = redirectUri
	const provider = createCliOAuthProvider({
		mcpUrl,
		redirectUri,
		loadStoredTokens: false,
		openBrowser: options.openBrowser !== false,
		expectedState,
		onAuthorizationUrl: (url) => {
			authorizationUrl = url
			options.onAuthorizationUrl?.(url)
		},
	})
	try {
		const first = await auth(provider, {
			serverUrl: mcpUrl,
			scope: defaultScopes.join(' '),
			fetchFn: options.fetchFn,
		})
		if (first !== 'AUTHORIZED') {
			const callback = await waitForCallback({
				server,
				redirectUri,
				expectedState,
				timeoutMs: options.timeoutMs ?? loginTimeoutMs,
			})
			const exchanged = await auth(provider, {
				serverUrl: mcpUrl,
				authorizationCode: callback.code,
				...(callback.iss ? { iss: callback.iss } : {}),
				scope: defaultScopes.join(' '),
				fetchFn: options.fetchFn,
			})
			if (exchanged !== 'AUTHORIZED') {
				throw new Error('OAuth redirect completed without tokens.')
			}
		} else {
			server.close()
		}
		const { credentials, saved } = await persistAuthorizedSession({
			mcpUrl,
			provider,
			backend: options.backend,
			now: options.now?.(),
		})
		return {
			credentials,
			authorizationUrl,
			backendKind: saved.backend.kind,
			backendPath: saved.backend.path,
		}
	} catch (error) {
		server.close()
		throw redactError(error)
	}
}
