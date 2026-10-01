import {
	apiTokenMintInstructions,
	featureDisabledMessage,
	insufficientScopeMessage,
	isScopedApiToken,
	rejectedOauthBearerMessage,
} from './api-token.js'
import { apiTokenEnvVar, cliName } from './defaults.js'
import { describeNetworkError } from './network-error.js'
import { readPackageVersion } from './package-info.js'

/**
 * HTTP contract for Kody's CapabilityProxy (Open API `/v1`). Local execute
 * runs user code in workerd and forwards every `kody:runtime` call here with
 * a Bearer from `--token` / `KODY_API_TOKEN` or (when unset) `kody login`
 * OAuth access token.
 *
 * - `GET  /v1/capability-proxy/session` validates the token before workerd
 *   starts. 200 → `{ scopes?: string[], expiresAt?: string }`.
 * - `POST /v1/capability-proxy/call` with `{ path, args, conversationId? }`
 *   where `path` is the runtime property path (`['kody', 'emailSend']`,
 *   `['kody', 'mcp', server, tool]`, `['workflows', 'create']`) and `args`
 *   is the positional argument list. 200 → `{ result }`.
 *
 * Errors use `{ error: { code, message } }` (a bare string is accepted too).
 * 401 means the token is expired/revoked (or MCP OAuth until the platform
 * accepts it); 403 `feature_disabled` means the `local-execute` flag is off.
 */
export const capabilityProxySessionPath = 'v1/capability-proxy/session'
export const capabilityProxyCallPath = 'v1/capability-proxy/call'

export type CapabilityProxySession = {
	scopes: Array<string>
	expiresAt: string | null
}

export type CapabilityProxyCall = {
	path: Array<string>
	args: Array<unknown>
	conversationId?: string
}

export type CapabilityProxyClientInput = {
	apiUrl: string
	token: string
	fetchFn?: typeof fetch
	signal?: AbortSignal
}

export class CapabilityProxyError extends Error {
	readonly status: number | null
	readonly code: string | null

	constructor(
		message: string,
		options: { status?: number | null; code?: string | null } = {},
	) {
		super(message)
		this.name = 'CapabilityProxyError'
		this.status = options.status ?? null
		this.code = options.code ?? null
	}
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The bearer token must not cross the network in cleartext. */
export function assertTokenSafeApiUrl(apiUrl: string): void {
	let url: URL
	try {
		url = new URL(apiUrl)
	} catch {
		throw new Error(`Invalid Kody API URL: ${apiUrl}`)
	}
	if (url.protocol === 'https:') return
	if (url.protocol === 'http:' && loopbackHosts.has(url.hostname)) return
	throw new Error(
		`Refusing to send the API token to ${url.origin}: use https (plain http is only allowed for localhost).`,
	)
}

export function capabilityProxyUrl(apiUrl: string, path: string): URL {
	const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`
	return new URL(path, base)
}

export async function openCapabilityProxySession(
	input: CapabilityProxyClientInput,
): Promise<CapabilityProxySession> {
	const url = capabilityProxyUrl(input.apiUrl, capabilityProxySessionPath)
	const response = await send(input, url, { method: 'GET' })
	const body = await readJson(response)
	if (!response.ok) {
		throw describeFailure(response.status, body, url, 'session', input.token)
	}
	const record = isRecord(body) ? body : {}
	return {
		scopes: Array.isArray(record.scopes)
			? record.scopes.filter((scope): scope is string => typeof scope === 'string')
			: [],
		expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : null,
	}
}

export async function callCapabilityProxy(
	input: CapabilityProxyClientInput & CapabilityProxyCall,
): Promise<unknown> {
	const url = capabilityProxyUrl(input.apiUrl, capabilityProxyCallPath)
	const payload: CapabilityProxyCall = { path: input.path, args: input.args }
	if (input.conversationId !== undefined) payload.conversationId = input.conversationId
	const response = await send(input, url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	})
	const body = await readJson(response)
	if (!response.ok) {
		throw describeFailure(response.status, body, url, 'call', input.token)
	}
	const failure = readErrorBody(body)
	if (failure) {
		throw new CapabilityProxyError(failure.message, { status: response.status, code: failure.code })
	}
	return isRecord(body) ? body.result : undefined
}

async function send(
	input: CapabilityProxyClientInput,
	url: URL,
	init: RequestInit,
): Promise<Response> {
	const fetchFn = input.fetchFn ?? fetch
	try {
		return await fetchFn(url, {
			...init,
			signal: input.signal,
			headers: {
				...(init.headers as Record<string, string> | undefined),
				accept: 'application/json',
				authorization: `Bearer ${input.token}`,
				'user-agent': `${cliName}/${readPackageVersion()}`,
			},
		})
	} catch (error) {
		const reason = describeNetworkError(error)
		throw new CapabilityProxyError(
			`Could not reach the Kody API at ${url.origin} (${reason}). Check --api-url / KODY_API_URL and your network.`,
		)
	}
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
	if (!isRecord(body) || body.error == null) return null
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

function describeFailure(
	status: number,
	body: unknown,
	url: URL,
	stage: 'session' | 'call',
	token: string,
): CapabilityProxyError {
	const failure = readErrorBody(body)
	const code = failure?.code ?? null
	const detail = failure?.message ? ` Server said: ${failure.message}` : ''
	if (status === 401) {
		const message = isScopedApiToken(token)
			? `Kody rejected the API token (expired, revoked, or malformed). Mint a fresh scoped token and pass it with --token or ${apiTokenEnvVar}.${detail}`
			: `${rejectedOauthBearerMessage()}${detail}`
		return new CapabilityProxyError(message, { status, code })
	}
	if (code === 'feature_disabled') {
		return new CapabilityProxyError(`${featureDisabledMessage()}${detail}`, { status, code })
	}
	if (code === 'insufficient_scope') {
		return new CapabilityProxyError(
			`${insufficientScopeMessage({
				requiredScope: requiredScopeFrom(body),
				includeLocalExecute: true,
			})}${detail}`,
			{ status, code },
		)
	}
	if (status === 403 && stage === 'session') {
		return new CapabilityProxyError(
			`The API token is not allowed to use CapabilityProxy${code ? ` (${code})` : ''}. ${apiTokenMintInstructions()}${detail}`,
			{ status, code },
		)
	}
	if (status === 404 && stage === 'session') {
		return new CapabilityProxyError(
			`CapabilityProxy was not found at ${url.href}. Local execute may not be deployed on this Kody API yet; check --api-url / KODY_API_URL.`,
			{ status, code },
		)
	}
	return new CapabilityProxyError(
		failure?.message ?? `Kody API request failed with HTTP ${status} (${url.pathname}).`,
		{ status, code },
	)
}

function requiredScopeFrom(body: unknown): string | null {
	if (!isRecord(body) || !isRecord(body.error) || !isRecord(body.error.details)) return null
	const required = body.error.details.required_scope
	if (typeof required === 'string' && required.trim()) return required.trim()
	const requiredList = body.error.details.required_scopes
	if (!Array.isArray(requiredList)) return null
	const scopes = requiredList.filter(
		(scope): scope is string => typeof scope === 'string' && scope.trim().length > 0,
	)
	return scopes.length > 0 ? scopes.join(', ') : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
