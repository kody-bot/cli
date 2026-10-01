import { ensureFreshCredentials } from './auth.js'
import {
	missingLocalExecuteAuthMessage,
	readApiToken,
} from './api-token.js'
import { loadStoredApiToken } from './api-token-store.js'
import { defaultApiUrl } from './defaults.js'
import type { SecretBackend, StoreResolution } from './store.js'

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
export async function resolveLocalExecuteBearer(input: {
	tokenValues?: { token?: string }
	env?: NodeJS.ProcessEnv
	mcpUrl?: string
	apiUrl?: string
	backend?: SecretBackend
	apiTokenBackend?: SecretBackend
	apiTokenResolution?: StoreResolution
	fetchFn?: typeof fetch
	now?: number
	purpose?: string
	/** Test seam. */
	ensureCredentials?: typeof ensureFreshCredentials
	/** Test seam. */
	loadApiToken?: typeof loadStoredApiToken
}): Promise<string> {
	const token = readApiToken(input.tokenValues, input.env)
	if (token) return token

	const apiUrl = input.apiUrl || defaultApiUrl
	const loadApi = input.loadApiToken ?? loadStoredApiToken
	const stored = loadApi(apiUrl, input.apiTokenBackend, input.apiTokenResolution)
	if (stored?.token) return stored.token

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
