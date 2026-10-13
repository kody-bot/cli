import { spawnSync } from 'node:child_process'
import { apiTokenEnvVar, defaultApiUrl, defaultMcpUrl } from './defaults.js'
import {
	authBootstrapWithScopes,
	cliTokenLifetimeAliases,
	resolveCliTokenLifetime,
	type ResolvedCliTokenLifetime,
} from './auth-bootstrap.js'
import {
	loadStoredApiToken,
	type StoredApiToken,
} from './api-token-store.js'
import { OpenApiError, openApiGet } from './open-api-client.js'
import type { SecretBackend, StoreResolution } from './store.js'

/** Scopes setup-git always requires for clone/fetch (+ push). */
export const setupGitRequiredScopes = ['package:read', 'package:write'] as const

/**
 * Default mint list when setup-git needs a fresh token: CLI bootstrap defaults
 * plus the package scopes git HTTPS needs. Callers can replace via `--scopes`.
 */
export const setupGitDefaultScopes: ReadonlyArray<string> = [
	'app:execute',
	'app:read',
	'email:read',
	'email:send',
	'integration:read',
	'integration:use',
	'job:execute',
	'job:read',
	'memory:read',
	'org:execute',
	'org:read',
	'package:execute',
	'package:read',
	'package:write',
	'secret:use',
	'token:delete',
]

export type TokenCurrentMetadata = {
	id: string
	orgBinding: 'org' | 'user' | null
	scopes: Array<string>
	expiresAt: string | null
}

/**
 * Origin host for `credential.https://<host>.*` (guide: `kody.codes`).
 * Derived from the MCP URL origin so preview / self-host installs match.
 */
export function gitCredentialHostFromMcpUrl(mcpUrl: string = defaultMcpUrl): string {
	return new URL(mcpUrl).host
}

export function scopesIncludeRequired(
	scopes: ReadonlyArray<string> | null | undefined,
	required: ReadonlyArray<string> = setupGitRequiredScopes,
): boolean {
	if (!scopes) return false
	const held = new Set(scopes)
	return required.every((scope) => held.has(scope))
}

/** Ensure package:read/write are present; preserve order of the base list. */
export function ensureSetupGitScopes(
	base: ReadonlyArray<string> = setupGitDefaultScopes,
): Array<string> {
	const out = [...base]
	for (const required of setupGitRequiredScopes) {
		if (!out.includes(required)) out.push(required)
	}
	return out
}

export async function fetchTokenCurrentMetadata(input: {
	token: string
	apiUrl?: string
	fetchFn?: typeof fetch
}): Promise<TokenCurrentMetadata> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const current = (await openApiGet({
		token: input.token,
		apiUrl,
		path: 'v1/tokens/current',
		fetchFn: input.fetchFn,
	})) as Record<string, unknown>

	const orgBindingRaw = current.org_binding
	const orgBinding =
		orgBindingRaw === 'user' || orgBindingRaw === 'org' ? orgBindingRaw : null

	return {
		id: String(current.id ?? ''),
		orgBinding,
		scopes: Array.isArray(current.scopes)
			? current.scopes.filter((scope): scope is string => typeof scope === 'string')
			: [],
		expiresAt: typeof current.expires_at === 'string' ? current.expires_at : null,
	}
}

/**
 * User-owned tokens (and the git helper) require `org_binding` on token
 * metadata. Older origins omit the field — refuse rather than install a
 * broken helper.
 */
export function assertUserOwnedTokensLive(metadata: TokenCurrentMetadata): void {
	if (metadata.orgBinding === null) {
		throw new Error(
			'This Kody origin does not advertise user-owned API tokens (`org_binding` missing on GET /v1/tokens/current). Upgrade the server (kody auth setup-git / persistent git HTTPS) before installing the credential helper.',
		)
	}
}

export type SetupGitTokenDecision =
	| { action: 'reuse'; stored: StoredApiToken; metadata: TokenCurrentMetadata }
	| {
			action: 'mint'
			scopes: Array<string>
			lifetime: ResolvedCliTokenLifetime
			reason: string
	  }

/**
 * Reuse a stored user-owned token that already has package:read/write; otherwise
 * mint a long-lived user-owned token with those scopes.
 */
export function decideSetupGitToken(input: {
	stored: StoredApiToken | null
	metadata: TokenCurrentMetadata | null
	scopesOverride?: ReadonlyArray<string>
	lifetime?: ResolvedCliTokenLifetime
}): SetupGitTokenDecision {
	const lifetime =
		input.lifetime ??
		resolveCliTokenLifetime({ lifetime: 'long' })

	if (
		input.stored &&
		input.metadata &&
		input.metadata.orgBinding === 'user' &&
		scopesIncludeRequired(input.metadata.scopes) &&
		!input.scopesOverride
	) {
		return { action: 'reuse', stored: input.stored, metadata: input.metadata }
	}

	// Prefer extending the current token's scopes so a parent API token can
	// mint them; fall back to the setup-git default list for a blank slate.
	const scopes = ensureSetupGitScopes(
		input.scopesOverride ??
			input.metadata?.scopes ??
			input.stored?.scopes ??
			setupGitDefaultScopes,
	)

	const reason = !input.stored
		? 'No stored API token yet.'
		: input.metadata?.orgBinding !== 'user'
			? 'Stored token is not user-owned (`org_binding` must be `user`).'
			: !scopesIncludeRequired(input.metadata?.scopes)
				? 'Stored token is missing package:read and/or package:write.'
				: 'Minting with the requested --scopes list.'

	return { action: 'mint', scopes, lifetime, reason }
}

export type GitConfigRunner = (args: ReadonlyArray<string>) => {
	status: number
	stderr: string
}

export function defaultGitConfigRunner(args: ReadonlyArray<string>): {
	status: number
	stderr: string
} {
	const result = spawnSync('git', [...args], {
		encoding: 'utf8',
		env: process.env,
	})
	if (result.error) {
		return { status: 1, stderr: result.error.message }
	}
	return {
		status: result.status ?? 1,
		stderr: (result.stderr || '').trim(),
	}
}

/**
 * Install URL-scoped credential helper config from the server contract:
 * `credential.https://<host>.helper` and `.useHttpPath true`.
 */
export function installGitCredentialConfig(input: {
	host: string
	helperCommand: string
	global?: boolean
	runGit?: GitConfigRunner
}): { host: string; helperCommand: string; scope: '--global' | '--local' } {
	const runGit = input.runGit ?? defaultGitConfigRunner
	const scope = input.global === false ? '--local' : '--global'
	const helperKey = `credential.https://${input.host}.helper`
	const pathKey = `credential.https://${input.host}.useHttpPath`

	for (const [key, value] of [
		[helperKey, input.helperCommand],
		[pathKey, 'true'],
	] as const) {
		const result = runGit(['config', scope, key, value])
		if (result.status !== 0) {
			throw new Error(
				`git config ${scope} ${key} failed${result.stderr ? `: ${result.stderr}` : ''}. Is git installed?`,
			)
		}
	}

	return { host: input.host, helperCommand: input.helperCommand, scope }
}

/**
 * Helper argv for git config. Prefer the running Node entry so `npx` / local
 * builds work without requiring a global `kody` on PATH.
 */
export function gitCredentialHelperCommand(input?: {
	execPath?: string
	entryPath?: string
}): string {
	const execPath = input?.execPath ?? process.execPath
	const entryPath = input?.entryPath ?? process.argv[1]
	if (entryPath && entryPath.length > 0) {
		return `!${shellQuote(execPath)} ${shellQuote(entryPath)} git-credential`
	}
	return '!kody git-credential'
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value
	return `'${value.replace(/'/g, `'\\''`)}'`
}

export type AuthSetupGitResult = {
	host: string
	helperCommand: string
	tokenId: string
	scopes: Array<string>
	orgBinding: 'user'
	minted: boolean
	backendKind: string
	backendPath?: string
	expiresAt: string | null
}

export async function authSetupGit(input: {
	apiUrl?: string
	mcpUrl?: string
	token?: string
	scopesOverride?: ReadonlyArray<string>
	lifetime?: ResolvedCliTokenLifetime
	global?: boolean
	/**
	 * True when a `kody login` OAuth session is stored for `mcpUrl`. Login is
	 * enough to mint: the OAuth bearer cannot call `GET /v1/tokens/current`, so
	 * we skip that probe and assert `org_binding` on the minted `kody_at_…`.
	 * The minted token is user-owned (git auth is person-wide across orgs);
	 * login `--org` only scopes the MCP session used to mint.
	 */
	hasLoginSession?: boolean
	mint: (params: Record<string, unknown>) => Promise<unknown>
	fetchFn?: typeof fetch
	backend?: SecretBackend
	resolution?: StoreResolution
	runGit?: GitConfigRunner
	helperCommand?: string
}): Promise<AuthSetupGitResult> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const mcpUrl = input.mcpUrl || defaultMcpUrl
	const host = gitCredentialHostFromMcpUrl(mcpUrl)

	const storedExisting = loadStoredApiToken(apiUrl, input.backend, input.resolution)
	const probeToken = input.token || storedExisting?.token
	const hasLoginSession = input.hasLoginSession === true
	if (!probeToken && !hasLoginSession) {
		throw new Error(
			`setup-git needs a Kody credential to detect server support and mint a token. Run \`kody login\`, or set ${apiTokenEnvVar}, or pass --token.`,
		)
	}

	let probeMetadata: TokenCurrentMetadata | null = null
	if (probeToken) {
		try {
			probeMetadata = await fetchTokenCurrentMetadata({
				token: probeToken,
				apiUrl,
				fetchFn: input.fetchFn,
			})
		} catch (error) {
			if (error instanceof OpenApiError && error.status === 401) {
				throw new Error(
					`Could not read token metadata from ${apiUrl} (unauthorized). Run \`kody login\` or pass a valid --token / ${apiTokenEnvVar}.`,
				)
			}
			throw error
		}
		// Any live token's /tokens/current shape proves the origin supports org_binding.
		assertUserOwnedTokensLive(probeMetadata)
	}

	let storedMetadata: TokenCurrentMetadata | null = null
	if (storedExisting) {
		if (probeMetadata && storedExisting.token === probeToken) {
			storedMetadata = probeMetadata
		} else {
			try {
				storedMetadata = await fetchTokenCurrentMetadata({
					token: storedExisting.token,
					apiUrl,
					fetchFn: input.fetchFn,
				})
			} catch {
				storedMetadata = null
			}
		}
	}

	const decision = decideSetupGitToken({
		stored: storedExisting,
		metadata: storedMetadata,
		scopesOverride: input.scopesOverride,
		lifetime: input.lifetime,
	})

	let stored: StoredApiToken
	let minted = false
	let backendKind: string
	let backendPath: string | undefined

	let finalMetadata: TokenCurrentMetadata

	if (decision.action === 'reuse') {
		stored = decision.stored
		backendKind = 'existing'
		finalMetadata = decision.metadata
	} else {
		const result = await authBootstrapWithScopes({
			scopes: decision.scopes,
			lifetime: decision.lifetime,
			mint: input.mint,
			apiUrl,
			fetchFn: input.fetchFn,
			backend: input.backend,
			resolution: input.resolution,
		})
		stored = result.stored
		minted = true
		backendKind = result.backendKind
		backendPath = result.backendPath

		// Confirm the redeemed token is user-owned (new bootstrap default).
		const after = await fetchTokenCurrentMetadata({
			token: stored.token,
			apiUrl,
			fetchFn: input.fetchFn,
		})
		assertUserOwnedTokensLive(after)
		if (after.orgBinding !== 'user') {
			throw new Error(
				`Minted token ${stored.tokenId} has org_binding=${JSON.stringify(after.orgBinding)}; expected "user". Refusing to install the git helper.`,
			)
		}
		if (!scopesIncludeRequired(after.scopes)) {
			throw new Error(
				`Minted token ${stored.tokenId} is missing package:read and/or package:write. Pass --scopes that include both.`,
			)
		}
		finalMetadata = after
	}

	const helperCommand = input.helperCommand ?? gitCredentialHelperCommand()
	installGitCredentialConfig({
		host,
		helperCommand,
		global: input.global,
		runGit: input.runGit,
	})

	return {
		host,
		helperCommand,
		tokenId: stored.tokenId,
		scopes: finalMetadata.scopes,
		orgBinding: 'user',
		minted,
		backendKind,
		...(backendPath ? { backendPath } : {}),
		expiresAt: finalMetadata.expiresAt,
	}
}

export { cliTokenLifetimeAliases }
