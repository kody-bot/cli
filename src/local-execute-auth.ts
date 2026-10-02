import { ensureFreshCredentials } from './auth.js'
import {
	missingLocalExecuteAuthMessage,
	expectedPairedApiOrigin,
	isPairedApiUrl,
	resolveScopedApiToken,
	type ResolveScopedApiTokenInput,
} from './api-token.js'
import { defaultApiUrl, defaultMcpUrl } from './defaults.js'
import type { SecretBackend } from './store.js'

function urlOriginOrValue(value: string): string {
	try {
		return new URL(value).origin
	} catch {
		return value
	}
}

/**
 * Bearer for CapabilityProxy / package-graph under `execute --local`.
 *
 * Priority:
 * 1. `--token` / `KODY_API_TOKEN`
 * 2. Stored bootstrap/API token from `auth bootstrap --code`
 * 3. Fresh `kody login` OAuth access token (never printed)
 *
 * No under-the-hood `tokenCreate` exchange. Do not scavenge host MCP tokens
 * (ADR 0053).
 */
export async function resolveLocalExecuteBearer(
	input: ResolveScopedApiTokenInput & {
		mcpUrl?: string
		backend?: SecretBackend
		fetchFn?: typeof fetch
		now?: number
		purpose?: string
		/** Test seam. */
		ensureCredentials?: typeof ensureFreshCredentials
	},
): Promise<string> {
	const token = resolveScopedApiToken(input)
	if (token) return token

	const apiUrl = input.apiUrl ?? defaultApiUrl
	const mcpUrl = input.mcpUrl ?? defaultMcpUrl
	if (!isPairedApiUrl(apiUrl, mcpUrl)) {
		const apiOrigin = urlOriginOrValue(apiUrl)
		const mcpOrigin = urlOriginOrValue(mcpUrl)
		throw new Error(
			`kody login credentials for ${mcpOrigin} are only sent to ${expectedPairedApiOrigin(mcpUrl)}. For ${apiOrigin}, run \`kody auth bootstrap --code … --api-url ${apiOrigin}\` or set KODY_API_TOKEN.`,
		)
	}

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
