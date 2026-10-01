import { ensureFreshCredentials } from './auth.js'
import {
	missingLocalExecuteAuthMessage,
	readApiToken,
} from './api-token.js'
import type { SecretBackend } from './store.js'

/**
 * Bearer for CapabilityProxy / package-graph under `execute --local`.
 *
 * Priority: `--token` / `KODY_API_TOKEN`, else a fresh `kody login` OAuth
 * access token (never printed). No under-the-hood `tokenCreate` exchange.
 *
 * Platform must accept MCP/user OAuth on those Open API routes
 * (https://github.com/kentcdodds/kody/issues/2812); until then a login-only
 * bearer gets 401 and the CLI surfaces that gap.
 */
export async function resolveLocalExecuteBearer(input: {
	tokenValues?: { token?: string }
	env?: NodeJS.ProcessEnv
	mcpUrl?: string
	backend?: SecretBackend
	fetchFn?: typeof fetch
	now?: number
	purpose?: string
	/** Test seam. */
	ensureCredentials?: typeof ensureFreshCredentials
}): Promise<string> {
	const token = readApiToken(input.tokenValues, input.env)
	if (token) return token

	const ensure = input.ensureCredentials ?? ensureFreshCredentials
	try {
		const credentials = await ensure({
			mcpUrl: input.mcpUrl,
			backend: input.backend,
			fetchFn: input.fetchFn,
			now: input.now,
		})
		return credentials.accessToken
	} catch {
		throw new Error(missingLocalExecuteAuthMessage(input.purpose ?? 'execute --local'))
	}
}
