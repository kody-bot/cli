import { assertTokenSafeApiUrl, capabilityProxyUrl } from './capability-proxy.js'
import { cliName, defaultApiUrl } from './defaults.js'
import { describeNetworkError } from './network-error.js'
import { readPackageVersion } from './package-info.js'
import {
	saveStoredApiToken,
	type StoredApiToken,
} from './api-token-store.js'
import type { SecretBackend, StoreResolution } from './store.js'

/** ADR 0056 one-shot bootstrap code prefix (`kody_bc_…`). */
export const cliBootstrapCodePrefix = 'kody_bc_'

/** Platform shape: `kody_bc_<16 alnum>_<32 base64url>`. */
const bootstrapCodePattern = /^kody_bc_([a-z0-9]{16})_([A-Za-z0-9_-]{32})$/

export const bootstrapRedeemPath = 'v1/tokens/bootstrap/redeem'

export type BootstrapRedeemResponse = {
	token: string
	token_type?: string
	id: string
	name?: string | null
	scopes?: Array<string>
	status?: string
	idle_ttl_seconds?: number
	expires_at?: string | null
	max_expires_at?: string | null
	created_via?: string
}

export function parseCliBootstrapCode(value: string): { codeId: string; secret: string } | null {
	const match = bootstrapCodePattern.exec(value.trim())
	if (!match) return null
	const [, codeId, secret] = match
	if (!codeId || !secret) return null
	return { codeId, secret }
}

export function assertCliBootstrapCode(code: string): string {
	const trimmed = code.trim()
	if (!parseCliBootstrapCode(trimmed)) {
		throw new Error(
			`Invalid bootstrap code. Expected a one-shot ${cliBootstrapCodePrefix}… from cliCredentialBootstrap (MCP api / kody.cliCredentialBootstrap).`,
		)
	}
	return trimmed
}

/**
 * POST /v1/tokens/bootstrap/redeem with JSON `{ code }` and **no** Authorization
 * header (ADR 0056). Returns the minted `kody_at_…` once.
 */
export async function redeemBootstrapCode(input: {
	code: string
	apiUrl?: string
	fetchFn?: typeof fetch
}): Promise<BootstrapRedeemResponse> {
	const code = assertCliBootstrapCode(input.code)
	const apiUrl = input.apiUrl || defaultApiUrl
	assertTokenSafeApiUrl(apiUrl)
	const url = capabilityProxyUrl(apiUrl, bootstrapRedeemPath)
	const fetchFn = input.fetchFn ?? fetch
	let response: Response
	try {
		response = await fetchFn(url, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				'user-agent': `${cliName}/${readPackageVersion()}`,
			},
			body: JSON.stringify({ code }),
		})
	} catch (error) {
		const reason = describeNetworkError(error)
		throw new Error(
			`Could not reach the Kody API at ${url.origin} (${reason}). Check --api-url / KODY_API_URL and your network.`,
		)
	}
	const body = await readJson(response)
	if (!response.ok) {
		throw describeRedeemFailure(response.status, body, url)
	}
	return parseRedeemResponse(body)
}

export function storedApiTokenFromRedeem(input: {
	apiUrl: string
	redeemed: BootstrapRedeemResponse
}): StoredApiToken {
	const token = input.redeemed.token.trim()
	if (!token.startsWith('kody_at_')) {
		throw new Error('Bootstrap redeem did not return a scoped kody_at_… API token.')
	}
	return {
		version: 1,
		apiUrl: input.apiUrl,
		token,
		tokenId: input.redeemed.id,
		...(input.redeemed.name ? { name: input.redeemed.name } : {}),
		...(Array.isArray(input.redeemed.scopes) ? { scopes: input.redeemed.scopes } : {}),
		expiresAt: input.redeemed.expires_at ?? null,
		maxExpiresAt: input.redeemed.max_expires_at ?? null,
		createdVia: input.redeemed.created_via ?? 'cli-bootstrap',
	}
}

/**
 * Redeem a one-shot `kody_bc_…` and persist the resulting API token for
 * `execute --local`. Never returns the token string to callers that print
 * success output — use `stored.tokenId` / backend kind only.
 */
export async function authBootstrap(input: {
	code: string
	apiUrl?: string
	fetchFn?: typeof fetch
	backend?: SecretBackend
	resolution?: StoreResolution
}): Promise<{
	stored: StoredApiToken
	backendKind: SecretBackend['kind']
	backendPath?: string
}> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const redeemed = await redeemBootstrapCode({
		code: input.code,
		apiUrl,
		fetchFn: input.fetchFn,
	})
	const stored = storedApiTokenFromRedeem({ apiUrl, redeemed })
	const saved = saveStoredApiToken(stored, input.backend, input.resolution)
	return {
		stored,
		backendKind: saved.backend.kind,
		...(saved.backend.path ? { backendPath: saved.backend.path } : {}),
	}
}

function parseRedeemResponse(body: unknown): BootstrapRedeemResponse {
	if (!isRecord(body) || typeof body.token !== 'string' || typeof body.id !== 'string') {
		throw new Error('Bootstrap redeem returned an unexpected response.')
	}
	return {
		token: body.token,
		token_type: typeof body.token_type === 'string' ? body.token_type : undefined,
		id: body.id,
		name: typeof body.name === 'string' ? body.name : null,
		scopes: Array.isArray(body.scopes)
			? body.scopes.filter((scope): scope is string => typeof scope === 'string')
			: undefined,
		status: typeof body.status === 'string' ? body.status : undefined,
		idle_ttl_seconds:
			typeof body.idle_ttl_seconds === 'number' ? body.idle_ttl_seconds : undefined,
		expires_at: typeof body.expires_at === 'string' ? body.expires_at : null,
		max_expires_at: typeof body.max_expires_at === 'string' ? body.max_expires_at : null,
		created_via: typeof body.created_via === 'string' ? body.created_via : undefined,
	}
}

function describeRedeemFailure(status: number, body: unknown, url: URL): Error {
	const failure = readErrorBody(body)
	const detail = failure?.message ? ` Server said: ${failure.message}` : ''
	if (status === 400 || status === 401 || status === 403 || status === 404) {
		return new Error(
			`Bootstrap redeem failed (HTTP ${status}). The code may be invalid, expired, or already used. Call cliCredentialBootstrap again for a fresh code.${detail}`,
		)
	}
	return new Error(
		failure?.message ??
			`Bootstrap redeem failed with HTTP ${status} (${url.pathname}).${detail}`,
	)
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text()
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function readErrorBody(body: unknown): { code: string | null; message: string } | null {
	if (!isRecord(body) || body.error == null) {
		if (typeof body === 'string' && body.trim()) return { code: null, message: body }
		if (isRecord(body) && typeof body.message === 'string') {
			return { code: null, message: body.message }
		}
		return null
	}
	const { error } = body
	if (typeof error === 'string') return { code: null, message: error }
	if (isRecord(error)) {
		const code = typeof error.code === 'string' ? error.code : null
		const message =
			typeof error.message === 'string' ? error.message : code ?? JSON.stringify(error)
		return { code, message }
	}
	return { code: null, message: String(error) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
