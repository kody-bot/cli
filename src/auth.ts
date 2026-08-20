import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import {
	discoverOAuthServerInfo,
	exchangeAuthorization,
	refreshAuthorization,
	registerClient,
	startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
	AuthorizationServerMetadata,
	OAuthClientInformationMixed,
	OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
	accessTokenSkewMs,
	defaultMcpUrl,
	defaultScopes,
	loginTimeoutMs,
} from './defaults.js'
import { openUrl } from './open-url.js'
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

function clientInformationFrom(
	credentials: StoredCredentials,
): OAuthClientInformationMixed {
	return {
		client_id: credentials.clientId,
		...(credentials.clientSecret
			? { client_secret: credentials.clientSecret }
			: {}),
	}
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
	const info = await discoverOAuthServerInfo(credentials.mcpUrl, {
		fetchFn: input.fetchFn,
	})
	const tokens = await refreshAuthorization(info.authorizationServerUrl, {
		metadata: info.authorizationServerMetadata,
		clientInformation: clientInformationFrom(credentials),
		refreshToken: credentials.refreshToken,
		resource: new URL(credentials.resource),
		fetchFn: input.fetchFn,
	})
	const next = credentialsFromTokens({
		mcpUrl: credentials.mcpUrl,
		resource: credentials.resource,
		authorizationServerUrl: credentials.authorizationServerUrl,
		client: clientInformationFrom(credentials),
		tokens,
		previous: credentials,
		now: input.now,
	})
	saveCredentials(next, input.backend)
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

function startCallbackServer(): Promise<{ server: Server; redirectUri: URL }> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (!address || typeof address === 'string') {
				server.close()
				reject(new Error('Could not bind a localhost callback port.'))
				return
			}
			resolve({
				server,
				redirectUri: new URL(`http://127.0.0.1:${address.port}/callback`),
			})
		})
		server.on('error', reject)
	})
}

function waitForCallback(input: {
	server: Server
	redirectUri: URL
	expectedState: string
	timeoutMs: number
}): Promise<string> {
	return new Promise((resolve, reject) => {
		const finish = (error: Error | null, code?: string) => {
			clearTimeout(timer)
			input.server.close()
			if (error) reject(error)
			else resolve(code ?? '')
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
				finish(null, code)
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
	const fetchFn = options.fetchFn
	const info = await discoverOAuthServerInfo(mcpUrl, { fetchFn })
	const resource =
		info.resourceMetadata?.resource ??
		`${new URL(mcpUrl).origin}${new URL(mcpUrl).pathname}`
	const { server, redirectUri } = await startCallbackServer()
	try {
		const metadata = info.authorizationServerMetadata as
			| AuthorizationServerMetadata
			| undefined
		const client = await registerClient(info.authorizationServerUrl, {
			metadata,
			clientMetadata: {
				redirect_uris: [redirectUri.href],
				client_name: 'Kody CLI',
				client_uri: 'https://github.com/kody-bot/cli',
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
				scope: defaultScopes.join(' '),
			},
			scope: defaultScopes.join(' '),
			fetchFn,
		})
		const state = crypto.randomUUID()
		const { authorizationUrl, codeVerifier } = await startAuthorization(
			info.authorizationServerUrl,
			{
				metadata,
				clientInformation: client,
				redirectUrl: redirectUri,
				scope: defaultScopes.join(' '),
				state,
				resource: new URL(resource),
			},
		)
		options.onAuthorizationUrl?.(authorizationUrl)
		if (options.openBrowser !== false) {
			await openUrl(authorizationUrl.href)
		}
		const code = await waitForCallback({
			server,
			redirectUri,
			expectedState: state,
			timeoutMs: options.timeoutMs ?? loginTimeoutMs,
		})
		const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
			metadata,
			clientInformation: client,
			authorizationCode: code,
			codeVerifier,
			redirectUri,
			resource: new URL(resource),
			fetchFn,
		})
		const credentials = credentialsFromTokens({
			mcpUrl,
			resource,
			authorizationServerUrl: info.authorizationServerUrl,
			client,
			tokens,
			now: options.now?.(),
		})
		const saved = saveCredentials(credentials, options.backend)
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
