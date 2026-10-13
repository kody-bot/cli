import { createInterface } from 'node:readline'
import {
	authBootstrapWithScopes,
	cliCredentialBootstrapOperationId,
	resolveCliTokenLifetime,
} from './auth-bootstrap.js'
import {
	loadStoredApiToken,
	type StoredApiToken,
} from './api-token-store.js'
import { defaultApiUrl, defaultMcpUrl } from './defaults.js'
import { callKodyApiOperation } from './mcp.js'
import {
	apiTokenNeedsRefresh,
	ensureSetupGitScopes,
	gitCredentialHostFromMcpUrl,
	setupGitDefaultScopes,
} from './setup-git.js'
import { loadCredentials, type SecretBackend, type StoreResolution } from './store.js'

export type GitCredentialAction = 'get' | 'store' | 'erase'

export type GitCredentialRequest = {
	protocol?: string
	host?: string
	path?: string
	username?: string
	password?: string
}

/**
 * Parse git credential helper stdin (`key=value` lines, blank line ends).
 * See `git help credential`.
 */
export function parseGitCredentialInput(text: string): GitCredentialRequest {
	const out: GitCredentialRequest = {}
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue
		const eq = line.indexOf('=')
		if (eq <= 0) continue
		const key = line.slice(0, eq)
		const value = line.slice(eq + 1)
		switch (key) {
			case 'protocol':
			case 'host':
			case 'path':
			case 'username':
			case 'password':
				out[key] = value
				break
			default:
				break
		}
	}
	return out
}

export function formatGitCredentialOutput(input: {
	username: string
	password: string
}): string {
	return `username=${input.username}\npassword=${input.password}\n`
}

export function isKodyGitHttpsHost(input: {
	protocol?: string
	host?: string
	expectedHost: string
}): boolean {
	if (input.protocol && input.protocol !== 'https') return false
	if (!input.host) return false
	return input.host.toLowerCase() === input.expectedHost.toLowerCase()
}

export type EnsureGitApiTokenResult = {
	stored: StoredApiToken
	refreshed: boolean
}

/**
 * Return a usable stored API token for git HTTPS with **no network** while the
 * stored token is still valid (outside the refresh skew). Remint only when
 * missing, expired, or near expiry — via the `kody login` session (same
 * scopes/lifetime as `auth setup-git`). Without a login session, returns the
 * existing token if any (may still work) or null.
 */
export async function ensureGitApiToken(input: {
	apiUrl?: string
	mcpUrl?: string
	nowMs?: number
	backend?: SecretBackend
	resolution?: StoreResolution
	/** Test seam: mint cliCredentialBootstrap (defaults to MCP login session). */
	mint?: (params: Record<string, unknown>) => Promise<unknown>
	loadLogin?: typeof loadCredentials
	loadApiToken?: typeof loadStoredApiToken
}): Promise<EnsureGitApiTokenResult | null> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const mcpUrl = input.mcpUrl || defaultMcpUrl
	const loadApi = input.loadApiToken ?? loadStoredApiToken
	const loadLogin = input.loadLogin ?? loadCredentials
	const stored = loadApi(apiUrl, input.backend, input.resolution)
	const nowMs = input.nowMs ?? Date.now()
	if (stored && !apiTokenNeedsRefresh(stored, nowMs)) {
		return { stored, refreshed: false }
	}

	if (!loadLogin(mcpUrl)) {
		return stored ? { stored, refreshed: false } : null
	}

	const mint =
		input.mint ??
		(async (params: Record<string, unknown>) =>
			callKodyApiOperation({
				operationId: cliCredentialBootstrapOperationId,
				params,
				mcpUrl,
			}))

	try {
		const scopes = ensureSetupGitScopes(
			stored?.scopes?.length ? stored.scopes : setupGitDefaultScopes,
		)
		const result = await authBootstrapWithScopes({
			scopes,
			lifetime: resolveCliTokenLifetime({ lifetime: 'long' }),
			mint,
			apiUrl,
			backend: input.backend,
			resolution: input.resolution,
		})
		return { stored: result.stored, refreshed: true }
	} catch {
		// Stay silent on the git credential protocol (stdout). Fall back to
		// whatever token we still have so a transient mint failure does not
		// immediately break an otherwise-valid session.
		return stored ? { stored, refreshed: false } : null
	}
}

/**
 * Handle one git credential helper action.
 * - `get`: return a `kody_at_…` for the configured Kody HTTPS host (reminting
 *   via `kody login` when the stored token is expired / near expiry)
 * - `store` / `erase`: no-op (token life is managed by remint / logout)
 */
export async function handleGitCredential(input: {
	action: GitCredentialAction
	request: GitCredentialRequest
	apiUrl?: string
	mcpUrl?: string
	backend?: SecretBackend
	resolution?: StoreResolution
	nowMs?: number
	mint?: (params: Record<string, unknown>) => Promise<unknown>
	loadLogin?: typeof loadCredentials
	loadApiToken?: typeof loadStoredApiToken
}): Promise<string> {
	if (input.action === 'store' || input.action === 'erase') {
		return ''
	}
	if (input.action !== 'get') {
		throw new Error(`Unknown git-credential action "${String(input.action)}".`)
	}

	const expectedHost = gitCredentialHostFromMcpUrl(input.mcpUrl || defaultMcpUrl)
	if (
		!isKodyGitHttpsHost({
			protocol: input.request.protocol,
			host: input.request.host,
			expectedHost,
		})
	) {
		return ''
	}

	const ensured = await ensureGitApiToken({
		apiUrl: input.apiUrl,
		mcpUrl: input.mcpUrl,
		backend: input.backend,
		resolution: input.resolution,
		nowMs: input.nowMs,
		mint: input.mint,
		loadLogin: input.loadLogin,
		loadApiToken: input.loadApiToken,
	})
	if (!ensured?.stored.token) {
		return ''
	}

	return formatGitCredentialOutput({
		username: 'x',
		password: ensured.stored.token,
	})
}

export function parseGitCredentialAction(argv: ReadonlyArray<string>): GitCredentialAction {
	const action = argv[0]
	if (action === 'get' || action === 'store' || action === 'erase') return action
	throw new Error(
		'Usage: kody git-credential <get|store|erase>\n(Git invokes this as a credential helper; see `kody auth setup-git`.)',
	)
}

/** Read stdin until EOF (git closes after the attribute block). */
export async function readGitCredentialStdin(
	stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
	if ('isTTY' in stdin && stdin.isTTY) return ''
	const chunks: Array<string> = []
	const rl = createInterface({ input: stdin, crlfDelay: Infinity })
	for await (const line of rl) {
		chunks.push(line)
	}
	return chunks.join('\n')
}
