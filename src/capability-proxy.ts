import type { Dispatcher } from 'undici'
import {
	apiTokenMintInstructions,
	cliBootstrapInstructions,
	featureDisabledMessage,
	insufficientScopeMessage,
	readInsufficientScopeDetails,
	isScopedApiToken,
	rejectedOauthBearerMessage,
} from './api-token.js'
import {
	formatCredentialClientError,
	type CredentialCallMapInput,
} from './credential-call-map.js'
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
 *   starts. 200 → `{ scopes?: string[], expiresAt?: string, features?: string[] }`.
 * - `POST /v1/capability-proxy/call` with
 *   `{ path, args, conversationId?, credentials? }` where `path` is the runtime
 *   property path (`['kody', 'emailSend']`, `['kody', 'mcp', server, tool]`,
 *   `['workflows', 'create']`) and `args` is the positional argument list.
 *   `credentials` is the ADR 0068 call map (CLI `--credential`); local code
 *   controls only `args`, so it cannot pick by name. 200 → `{ result }`.
 *
 * Errors use `{ error: { code, message } }` (a bare string is accepted too).
 * 401 means the token is expired/revoked (or MCP OAuth until the platform
 * accepts it); 403 `feature_disabled` means the `local-execute` flag is off.
 */
export const capabilityProxySessionPath = 'v1/capability-proxy/session'
export const capabilityProxyCallPath = 'v1/capability-proxy/call'

/**
 * Origin runs a placeholder `fetch` under a 5-minute deadline that starts only
 * after quota checks and placeholder fill, buffers the whole upstream body,
 * and sends headers once that body has ended. Node's global fetch gives up
 * after 300s without headers (undici `headersTimeout`), which would cut the
 * call before the gateway's own deadline fires, so CapabilityProxy requests
 * use a dedicated undici Agent that waits longer than the deadline plus
 * origin overhead.
 */
export const capabilityProxyGatewayDeadlineMs = 5 * 60_000
export const capabilityProxyHttpTimeoutMs = 7 * 60_000

/**
 * Node routes global fetch through `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
 * only when `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` is set. A dispatcher
 * passed to fetch replaces that global proxy agent, so mirror the same opt-in.
 */
export function nodeUsesEnvProxy(
	env: NodeJS.ProcessEnv = process.env,
	execArgv: ReadonlyArray<string> = process.execArgv,
): boolean {
	if (env.NODE_USE_ENV_PROXY === '1') return true
	const flags = [...execArgv, ...(env.NODE_OPTIONS ?? '').split(/\s+/)]
	return flags.includes('--use-env-proxy')
}

export async function createCapabilityProxyAgent(
	timeoutMs: number = capabilityProxyHttpTimeoutMs,
	options: { useEnvProxy?: boolean } = {},
): Promise<Dispatcher> {
	// undici costs ~55ms to load, so only the commands that send a request pay for it.
	const { Agent, EnvHttpProxyAgent } = await import('undici')
	const timeouts = { headersTimeout: timeoutMs, bodyTimeout: timeoutMs }
	return (options.useEnvProxy ?? nodeUsesEnvProxy())
		? new EnvHttpProxyAgent(timeouts)
		: new Agent(timeouts)
}

let defaultCapabilityProxyAgent: Promise<Dispatcher> | null = null

function capabilityProxyAgent(): Promise<Dispatcher> {
	defaultCapabilityProxyAgent ??= createCapabilityProxyAgent()
	return defaultCapabilityProxyAgent
}

export type CapabilityProxySession = {
	scopes: Array<string>
	expiresAt: string | null
	/** Host features, e.g. `credential-call-map` for `--credential`. */
	features: Array<string>
}

export type CapabilityProxyCall = {
	path: Array<string>
	args: Array<unknown>
	conversationId?: string
	/** ADR 0068 call map; top-level only (never nested under `args`). */
	credentials?: CredentialCallMapInput
}

export type CapabilityProxyClientInput = {
	apiUrl: string
	token: string
	fetchFn?: typeof fetch
	signal?: AbortSignal
	/** Defaults to the shared Agent from `createCapabilityProxyAgent()`. */
	dispatcher?: Dispatcher
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
		features: Array.isArray(record.features)
			? record.features.filter((feature): feature is string => typeof feature === 'string')
			: [],
	}
}

export async function callCapabilityProxy(
	input: CapabilityProxyClientInput & CapabilityProxyCall,
): Promise<unknown> {
	const url = capabilityProxyUrl(input.apiUrl, capabilityProxyCallPath)
	const payload: CapabilityProxyCall = { path: input.path, args: input.args }
	if (input.conversationId !== undefined) payload.conversationId = input.conversationId
	if (input.credentials !== undefined) payload.credentials = input.credentials
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

/**
 * Preflight ADR 0068 call-map picks via `kody.credentialClientCheck` before
 * local code runs. Throws on a structured check failure; returns warnings for
 * ad hoc (non-strict) unknown keys.
 */
export async function checkCredentialCallMap(
	input: CapabilityProxyClientInput & {
		credentials: CredentialCallMapInput
		conversationId?: string
		/** Invoke / package entry: unknown keys are errors. */
		strict?: boolean
		packageId?: string
	},
): Promise<{ warnings: Array<string> }> {
	const args: Record<string, unknown> = {}
	if (input.strict === true) args.strict = true
	if (input.packageId !== undefined) args.packageId = input.packageId
	const result = await callCapabilityProxy({
		apiUrl: input.apiUrl,
		token: input.token,
		fetchFn: input.fetchFn,
		signal: input.signal,
		dispatcher: input.dispatcher,
		path: ['kody', 'credentialClientCheck'],
		args: [args],
		conversationId: input.conversationId,
		credentials: input.credentials,
	})
	if (!isRecord(result)) {
		throw new CapabilityProxyError('credentialClientCheck returned an unexpected result.')
	}
	if (result.ok === false) {
		const error = isRecord(result.error) ? result.error : {}
		const code = typeof error.code === 'string' ? error.code : 'credential_error'
		throw new CapabilityProxyError(formatCredentialClientError(error), { code })
	}
	const value = isRecord(result.value) ? result.value : null
	const warnings = Array.isArray(value?.warnings)
		? value.warnings.filter((warning): warning is string => typeof warning === 'string')
		: []
	return { warnings }
}

async function send(
	input: CapabilityProxyClientInput,
	url: URL,
	init: RequestInit,
): Promise<Response> {
	const fetchFn = input.fetchFn ?? fetch
	// Global fetch on Node 22+ (bundled undici 6–8) accepts undici 7 dispatchers.
	const dispatcherInit = { dispatcher: input.dispatcher ?? (await capabilityProxyAgent()) }
	try {
		return await fetchFn(url, {
			...init,
			...dispatcherInit,
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
			`${insufficientScopeMessage(readInsufficientScopeDetails(body))}${detail}`,
			{ status, code },
		)
	}
	if (status === 403 && stage === 'session') {
		return new CapabilityProxyError(
			`The API token is not allowed to use CapabilityProxy${code ? ` (${code})` : ''}. ${cliBootstrapInstructions()} (lifetime short|long). ${apiTokenMintInstructions()}${detail}`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
