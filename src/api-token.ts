import { apiTokenEnvVar } from './defaults.js'

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

/**
 * How to mint the scoped token this CLI already accepts. There is no second
 * auth flow here — callers use the MCP `api` tool they already have.
 */
export function apiTokenMintInstructions(): string {
	return `Mint one with the Kody MCP \`api\` tool \`tokenCreate\` (include the \`local-execute\` scope plus the capability scopes this command needs) and pass --token or set ${apiTokenEnvVar}.`
}

/** `execute --local` never reads stored CLI OAuth, so login is not a substitute. */
export function missingApiTokenMessage(purpose: string): string {
	return `${purpose} needs a scoped Kody API token. ${apiTokenMintInstructions()} Stored \`kody login\` credentials are not used on this path.`
}

/** Cloud search / whoami / execute when the process has neither a session nor a token. */
export function missingCliAuthMessage(): string {
	return `Not logged in, and no API token is set. ${apiTokenMintInstructions()} Or run \`kody login\` for browser OAuth (search, whoami, and cloud execute).`
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
