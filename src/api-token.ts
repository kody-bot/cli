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

export function requireApiToken(
	values: { token?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
	purpose: string = 'this command',
): string {
	const token = readApiToken(values, env)
	if (!token) {
		throw new Error(
			`${purpose} needs a scoped Kody API token: pass --token or set ${apiTokenEnvVar}. Mint one with the Kody \`api\` tool (tokenCreate) or POST /v1/tokens.`,
		)
	}
	return token
}

/** True when the user passed `--token` (not only the env var). */
export function hasExplicitTokenFlag(values: { token?: string }): boolean {
	return typeof values.token === 'string' && values.token.trim().length > 0
}
