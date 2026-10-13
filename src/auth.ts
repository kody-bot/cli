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
import { missingCliAuthMessage } from './api-token.js'
import {
	accessTokenSkewMs,
	cliRedirectUrl,
	defaultMcpUrl,
	defaultScopes,
	loginTimeoutMs,
} from './defaults.js'
import {
	discoverLoginIdentity,
	type LoginIdentity,
} from './discover-login-identity.js'
import {
	loginCallbackErrorFromOAuthError,
	renderLoginCallbackPage,
	type LoginCallbackAccount,
	type LoginCallbackErrorKind,
} from './login-callback-page.js'
import { createCliOAuthProvider, orgSlugFromFlag } from './oauth-provider.js'
import { redactError } from './redact.js'
import {
	loadCredentials,
	saveCredentials,
	type SecretBackend,
	type StoredCredentials,
} from './store.js'

export type LoginOptions = {
	mcpUrl?: string
	/** Organization slug. Omit to let the server bind the sole or signup org. */
	org?: string
	openBrowser?: boolean
	backend?: SecretBackend
	timeoutMs?: number
	now?: () => number
	fetchFn?: typeof fetch
	onAuthorizationUrl?: (url: URL) => void
	/**
	 * Test seam / coordination with multi-org login (#42): resolve org +
	 * account after the code exchange so the localhost callback page can show
	 * them. Defaults to `metaGetCurrentUser` via {@link discoverLoginIdentity}.
	 */
	discoverIdentity?: (input: {
		mcpUrl: string
		accessToken: string
		fetchFn?: typeof fetch
	}) => Promise<LoginIdentity>
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
	const clientIssuer =
		'issuer' in client && typeof client.issuer === 'string'
			? client.issuer
			: undefined
	const credentials = credentialsFromTokens({
		mcpUrl: input.mcpUrl,
		resource: input.mcpUrl,
		authorizationServerUrl:
			tokens.issuer ??
			clientIssuer ??
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
		throw new Error(missingCliAuthMessage())
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

type CallbackSuccess = {
	code: string
	iss?: string
	/**
	 * Hold the browser response open until exchange + identity resolve, then
	 * write the designed success/error page (never echoes code/tokens).
	 */
	complete: (page: Parameters<typeof renderLoginCallbackPage>[0]) => void
}

function sendCallbackHtml(
	response: ServerResponse,
	status: number,
	page: Parameters<typeof renderLoginCallbackPage>[0],
): void {
	if (response.headersSent) return
	response.writeHead(status, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
	})
	response.end(renderLoginCallbackPage(page))
}

function waitForCallback(input: {
	server: Server
	redirectUri: URL
	expectedState: string
	timeoutMs: number
}): Promise<CallbackSuccess> {
	return new Promise((resolve, reject) => {
		let settled = false
		let pendingResponse: ServerResponse | undefined

		const closeServer = () => {
			input.server.close()
		}

		const rejectOnce = (error: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			closeServer()
			reject(error)
		}

		const resolveOnce = (result: CallbackSuccess) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(result)
		}

		const timer = setTimeout(() => {
			if (pendingResponse && !pendingResponse.headersSent) {
				sendCallbackHtml(pendingResponse, 408, {
					kind: 'error',
					error: 'expired',
				})
			}
			rejectOnce(new Error('Timed out waiting for the browser login.'))
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
					const kind = loginCallbackErrorFromOAuthError(error)
					sendCallbackHtml(response, 400, { kind: 'error', error: kind })
					rejectOnce(new Error(description || error))
					return
				}
				const state = url.searchParams.get('state')
				const code = url.searchParams.get('code')
				const iss = url.searchParams.get('iss') ?? undefined
				if (state !== input.expectedState || !code) {
					const kind: LoginCallbackErrorKind =
						state && state !== input.expectedState
							? 'state_mismatch'
							: 'failed'
					sendCallbackHtml(response, 400, { kind: 'error', error: kind })
					rejectOnce(new Error('OAuth callback missing code or state.'))
					return
				}
				pendingResponse = response
				resolveOnce({
					code,
					...(iss ? { iss } : {}),
					complete(page) {
						sendCallbackHtml(
							response,
							page.kind === 'success' ? 200 : 400,
							page,
						)
						closeServer()
					},
				})
			} catch (error) {
				rejectOnce(redactError(error))
			}
		})
	})
}

export async function login(options: LoginOptions = {}): Promise<{
	credentials: StoredCredentials
	authorizationUrl: URL
	backendKind: 'keyring' | 'file'
	backendPath?: string
	org?: string
	account?: LoginCallbackAccount
}> {
	const mcpUrl = options.mcpUrl ?? defaultMcpUrl
	const orgHint =
		options.org === undefined ? undefined : orgSlugFromFlag(options.org)
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
		...(orgHint ? { org: orgHint } : {}),
		onAuthorizationUrl: (url) => {
			authorizationUrl = url
			options.onAuthorizationUrl?.(url)
		},
	})
	let completeCallback: CallbackSuccess['complete'] | undefined
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
			completeCallback = callback.complete
			const exchanged = await auth(provider, {
				serverUrl: mcpUrl,
				authorizationCode: callback.code,
				...(callback.iss ? { iss: callback.iss } : {}),
				scope: defaultScopes.join(' '),
				fetchFn: options.fetchFn,
			})
			if (exchanged !== 'AUTHORIZED') {
				completeCallback({ kind: 'error', error: 'failed' })
				completeCallback = undefined
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

		let org = orgHint
		let account: LoginCallbackAccount | undefined
		const discover = options.discoverIdentity ?? discoverLoginIdentity
		try {
			const identity = await discover({
				mcpUrl,
				accessToken: credentials.accessToken,
				fetchFn: options.fetchFn,
			})
			if (orgHint && identity.org !== orgHint) {
				completeCallback?.({ kind: 'error', error: 'failed' })
				completeCallback = undefined
				throw new Error(
					`Login was bound to org "${identity.org}" but \`--org ${orgHint}\` was requested.`,
				)
			}
			org = identity.org
			account = identity.account
		} catch (error) {
			// Keep the saved session. Discovery feeds the callback page (and
			// multi-org #42); a transient metaGetCurrentUser failure must not
			// undo an otherwise successful OAuth exchange.
			if (
				error instanceof Error &&
				error.message.startsWith('Login was bound to org ')
			) {
				throw error
			}
		}

		completeCallback?.({
			kind: 'success',
			...(org ? { org } : {}),
			...(account ? { account } : {}),
		})
		completeCallback = undefined

		return {
			credentials,
			authorizationUrl,
			backendKind: saved.backend.kind,
			backendPath: saved.backend.path,
			...(org ? { org } : {}),
			...(account ? { account } : {}),
		}
	} catch (error) {
		completeCallback?.({ kind: 'error', error: 'failed' })
		server.close()
		throw redactError(error)
	}
}
