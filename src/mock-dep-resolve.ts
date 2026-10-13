/**
 * When `--target mock`, CapabilityProxy stays on the CLI mock but stamped
 * `kody:@` module *source* is fetched from prod package-graph (published
 * source is not a secret). Returns undefined when no prod bearer is available.
 */

import { resolveScopedApiToken } from './api-token.js'
import { defaultApiUrl, defaultMcpUrl } from './defaults.js'
import { resolveLocalExecuteBearer } from './local-execute-auth.js'

export type MockDepResolveClient = {
	apiUrl: string
	token: string
	org?: string
}

/**
 * Best-effort prod bearer for mock package-graph. Prefer a scoped API token
 * (no interactive login); fall back to `kody login` OAuth when paired.
 */
export async function tryResolveMockDepResolve(input: {
	tokenValues?: { token?: string }
	apiUrl?: string
	mcpUrl?: string
	org?: string
	env?: NodeJS.ProcessEnv
}): Promise<MockDepResolveClient | undefined> {
	const apiUrl = input.apiUrl ?? defaultApiUrl
	const mcpUrl = input.mcpUrl ?? defaultMcpUrl
	const scoped = resolveScopedApiToken({
		tokenValues: input.tokenValues,
		apiUrl,
		env: input.env,
	})
	if (scoped) {
		return {
			apiUrl,
			token: scoped,
			...(input.org ? { org: input.org } : {}),
		}
	}
	try {
		const token = await resolveLocalExecuteBearer({
			tokenValues: input.tokenValues,
			apiUrl,
			mcpUrl,
			purpose: 'mock kody:@ dependency resolve',
			...(input.org ? { org: input.org } : {}),
			env: input.env,
		})
		return {
			apiUrl,
			token,
			...(input.org ? { org: input.org } : {}),
		}
	} catch {
		return undefined
	}
}
