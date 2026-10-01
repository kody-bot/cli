import { apiTokenEnvVar } from './defaults.js'

/** Platform tracking for login OAuth as CapabilityProxy / package-graph Bearer. */
export const localExecuteOauthPlatformIssueUrl =
	'https://github.com/kentcdodds/kody/issues/2812'

/**
 * Scoped Open API / CapabilityProxy token (`kody_at_…`). Same source for
 * `execute --local`, token-only cloud execute, and Open API search/whoami.
 */
export function readApiToken(
	values: { token?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const token = (values.token ?? env[apiTokenEnvVar] ?? '').trim()
	return token.length > 0 ? token : null
}

/** True when the bearer looks like a minted Open API token (not MCP OAuth). */
export function isScopedApiToken(token: string): boolean {
	return token.startsWith('kody_at_')
}

/**
 * How to mint the scoped token this CLI already accepts. There is no second
 * auth flow here — callers use the MCP `api` tool they already have.
 */
export function apiTokenMintInstructions(): string {
	return `Mint one with the Kody MCP \`api\` tool \`tokenCreate\` (include the \`local-execute\` scope plus the capability scopes this command needs) and pass --token or set ${apiTokenEnvVar}.`
}

/** Token-only Open API paths (search / whoami / cloud token execute) with no token. */
export function missingApiTokenMessage(purpose: string): string {
	return `${purpose} needs a scoped Kody API token. ${apiTokenMintInstructions()}`
}

/**
 * `execute --local` with neither `--token` / `KODY_API_TOKEN` nor `kody login`.
 */
export function missingLocalExecuteAuthMessage(
	purpose: string = 'execute --local',
): string {
	return `${purpose} needs auth. Run \`kody login\`, or ${apiTokenMintInstructions()}`
}

/** Cloud search / whoami / execute when the process has neither a session nor a token. */
export function missingCliAuthMessage(): string {
	return `Not logged in, and no API token is set. ${apiTokenMintInstructions()} Or run \`kody login\` for browser OAuth (search, whoami, cloud execute, and login-backed \`execute --local\`).`
}

/** 401 when CapabilityProxy rejected a non-`kody_at_` bearer (typically CLI OAuth). */
export function rejectedOauthBearerMessage(): string {
	return `Kody rejected the bearer from \`kody login\`: the Open API still accepts only scoped \`kody_at_…\` API tokens on CapabilityProxy / package-graph (not MCP OAuth). See ${localExecuteOauthPlatformIssueUrl}. Until that lands, ${apiTokenMintInstructions()}`
}

export function insufficientScopeMessage(input: {
	requiredScope?: string | null
	/** CapabilityProxy execute needs `local-execute` plus the capability scopes. */
	includeLocalExecute?: boolean
}): string {
	const required = input.requiredScope ? ` The server requires "${input.requiredScope}".` : ''
	const mint = input.includeLocalExecute
		? apiTokenMintInstructions()
		: `Mint a token with the Kody MCP \`api\` tool \`tokenCreate\`${
				input.requiredScope
					? ` that includes "${input.requiredScope}"`
					: ' that includes the required scope'
			}, then pass --token or set ${apiTokenEnvVar}.`
	return `Kody returned insufficient_scope.${required} ${mint}`
}

export function featureDisabledMessage(): string {
	return 'Kody returned feature_disabled: CapabilityProxy is not enabled for this Kody account (feature flag `local-execute`). `execute --local` and token-auth cloud execute both stop here; minting another token does not bypass the flag. Browser `kody login` can still run cloud execute over MCP.'
}

export function requireApiToken(
	values: { token?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
	purpose: string = 'this command',
): string {
	const token = readApiToken(values, env)
	if (!token) throw new Error(missingApiTokenMessage(purpose))
	return token
}

/** True when the user passed `--token` (not only the env var). */
export function hasExplicitTokenFlag(values: { token?: string }): boolean {
	return typeof values.token === 'string' && values.token.trim().length > 0
}
