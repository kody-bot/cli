import { insufficientScopeMessage } from './api-token.js'
import { apiTokenEnvVar, cliName, defaultApiUrl } from './defaults.js'
import { assertTokenSafeApiUrl, capabilityProxyUrl } from './capability-proxy.js'
import { describeNetworkError } from './network-error.js'
import type { ToolCallResult } from './mcp.js'
import { readPackageVersion } from './package-info.js'

export type OpenApiClientInput = {
	apiUrl?: string
	token: string
	fetchFn?: typeof fetch
}

export class OpenApiError extends Error {
	readonly status: number | null
	readonly code: string | null

	constructor(
		message: string,
		options: { status?: number | null; code?: string | null } = {},
	) {
		super(message)
		this.name = 'OpenApiError'
		this.status = options.status ?? null
		this.code = options.code ?? null
	}
}

/** Path to the live OpenAPI document on the Kody API origin. */
export const openApiDocumentPath = 'openapi.json'

/**
 * Bootstrap redeem returns a `kody_at_…` once. Agents must use
 * `kody auth bootstrap --code` so the token is stored and never printed.
 */
export const cliCredentialBootstrapRedeemOperationId =
	'cliCredentialBootstrapRedeem'

export type OpenApiOperationRoute = {
	operationId: string
	method: string
	pathTemplate: string
	pathParamNames: Array<string>
}

const openApiRouteCache = new Map<string, Map<string, OpenApiOperationRoute>>()

export async function openApiGet(
	input: OpenApiClientInput & { path: string; query?: Record<string, string | number | undefined> },
): Promise<unknown> {
	return openApiRequest({
		...input,
		method: 'GET',
		path: input.path,
		query: input.query,
	})
}

/**
 * Authenticated Open API request (Bearer `kody_at_…`). Shared by search/whoami
 * helpers and `kody api <operationId>`.
 */
export async function openApiRequest(
	input: OpenApiClientInput & {
		method: string
		path: string
		query?: Record<string, unknown>
		body?: Record<string, unknown>
	},
): Promise<unknown> {
	const apiUrl = input.apiUrl || defaultApiUrl
	assertTokenSafeApiUrl(apiUrl)
	const url = capabilityProxyUrl(apiUrl, input.path.replace(/^\//, ''))
	if (input.query) {
		appendQueryParams(url.searchParams, input.query)
	}
	const method = input.method.toUpperCase()
	const headers: Record<string, string> = {
		accept: 'application/json',
		authorization: `Bearer ${input.token}`,
		'user-agent': `${cliName}/${readPackageVersion()}`,
	}
	let body: string | undefined
	if (input.body !== undefined && method !== 'GET' && method !== 'HEAD') {
		headers['content-type'] = 'application/json'
		body = JSON.stringify(input.body)
	}
	const fetchFn = input.fetchFn ?? fetch
	let response: Response
	try {
		response = await fetchFn(url, { method, headers, body })
	} catch (error) {
		const reason = describeNetworkError(error)
		throw new OpenApiError(
			`Could not reach the Kody API at ${url.origin} (${reason}). Check --api-url / KODY_API_URL and your network.`,
		)
	}
	const responseBody = await readJson(response)
	if (!response.ok) {
		throw describeOpenApiFailure(response.status, responseBody, url)
	}
	return responseBody
}

/**
 * Call one Open API operation by `operationId` + flat `params`, matching the
 * MCP `api` tool shape. Resolves method/path from `/openapi.json`.
 */
export async function callOpenApiOperation(
	input: OpenApiClientInput & {
		operationId: string
		params?: Record<string, unknown>
		/** Test seam: skip /openapi.json fetch. */
		operations?: Map<string, OpenApiOperationRoute>
	},
): Promise<unknown> {
	const operationId = input.operationId.trim()
	if (!operationId) {
		throw new OpenApiError('Provide an Open API operationId (e.g. usageGet, metaGetCurrentUser).')
	}
	assertApiOperationAllowed(operationId)
	const apiUrl = input.apiUrl || defaultApiUrl
	const operations =
		input.operations ?? (await loadOpenApiOperations({ apiUrl, fetchFn: input.fetchFn }))
	const route = operations.get(operationId)
	if (!route) {
		throw new OpenApiError(
			`Unknown operationId "${operationId}". Operation ids are listed in ${capabilityProxyUrl(apiUrl, openApiDocumentPath).href} and match Kody capability names (plus token operations such as tokenCreate).`,
			{ status: 404, code: 'not_found' },
		)
	}
	const built = buildOpenApiHttpRequest({
		route,
		params: input.params ?? {},
	})
	return openApiRequest({
		token: input.token,
		apiUrl,
		fetchFn: input.fetchFn,
		method: built.method,
		path: built.path,
		query: built.query,
		body: built.body,
	})
}

export function assertApiOperationAllowed(operationId: string): void {
	if (operationId === cliCredentialBootstrapRedeemOperationId) {
		throw new OpenApiError(
			`Refusing to call ${cliCredentialBootstrapRedeemOperationId}: redeem returns a kody_at_… token that must not print to stdout. Use \`kody auth bootstrap --code <kody_bc_…>\` instead (stores the token; never prints it).`,
			{ status: null, code: 'refused' },
		)
	}
}

/**
 * Split flat MCP-style params into path / query / body for an Open API route.
 * GET and DELETE send non-path fields as query; other methods send them as JSON body.
 */
export function buildOpenApiHttpRequest(input: {
	route: OpenApiOperationRoute
	params: Record<string, unknown>
}): {
	method: string
	path: string
	query?: Record<string, unknown>
	body?: Record<string, unknown>
} {
	const remaining: Record<string, unknown> = { ...input.params }
	const pathParams: Record<string, string> = {}
	for (const name of input.route.pathParamNames) {
		if (!(name in remaining) || remaining[name] === undefined || remaining[name] === null) {
			throw new OpenApiError(
				`Missing required path parameter "${name}" for ${input.route.operationId} (${input.route.pathTemplate}).`,
			)
		}
		pathParams[name] = String(remaining[name])
		delete remaining[name]
	}
	const path = fillPathTemplate(input.route.pathTemplate, pathParams)
	const method = input.route.method.toUpperCase()
	if (apiOperationUsesQueryInputs(method)) {
		return {
			method,
			path,
			...(Object.keys(remaining).length > 0 ? { query: remaining } : {}),
		}
	}
	return {
		method,
		path,
		body: remaining,
	}
}

export function apiOperationUsesQueryInputs(method: string): boolean {
	const upper = method.toUpperCase()
	return upper === 'GET' || upper === 'DELETE'
}

export async function loadOpenApiOperations(input: {
	apiUrl?: string
	fetchFn?: typeof fetch
	/** Bypass cache (tests). */
	bustCache?: boolean
}): Promise<Map<string, OpenApiOperationRoute>> {
	const apiUrl = input.apiUrl || defaultApiUrl
	assertTokenSafeApiUrl(apiUrl)
	const cacheKey = new URL(apiUrl).origin
	if (!input.bustCache) {
		const cached = openApiRouteCache.get(cacheKey)
		if (cached) return cached
	}
	const url = capabilityProxyUrl(apiUrl, openApiDocumentPath)
	const fetchFn = input.fetchFn ?? fetch
	let response: Response
	try {
		response = await fetchFn(url, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				'user-agent': `${cliName}/${readPackageVersion()}`,
			},
		})
	} catch (error) {
		const reason = describeNetworkError(error)
		throw new OpenApiError(
			`Could not load OpenAPI from ${url.href} (${reason}). Check --api-url / KODY_API_URL and your network.`,
		)
	}
	const body = await readJson(response)
	if (!response.ok) {
		throw new OpenApiError(
			`Could not load OpenAPI from ${url.href} (HTTP ${response.status}).`,
			{ status: response.status },
		)
	}
	const operations = indexOpenApiOperations(body)
	openApiRouteCache.set(cacheKey, operations)
	return operations
}

/** Visible for tests. */
export function indexOpenApiOperations(document: unknown): Map<string, OpenApiOperationRoute> {
	if (!isRecord(document) || !isRecord(document.paths)) {
		throw new OpenApiError('OpenAPI document is missing a paths object.')
	}
	const operations = new Map<string, OpenApiOperationRoute>()
	for (const [pathTemplate, methods] of Object.entries(document.paths)) {
		if (!isRecord(methods)) continue
		for (const [method, operation] of Object.entries(methods)) {
			if (!isRecord(operation)) continue
			const operationId =
				typeof operation.operationId === 'string' ? operation.operationId : ''
			if (!operationId) continue
			operations.set(operationId, {
				operationId,
				method: method.toUpperCase(),
				pathTemplate,
				pathParamNames: pathParamNamesFromTemplate(pathTemplate),
			})
		}
	}
	return operations
}

/** Clear the in-memory OpenAPI route cache (tests). */
export function clearOpenApiRouteCache(): void {
	openApiRouteCache.clear()
}

function pathParamNamesFromTemplate(pathTemplate: string): Array<string> {
	const names: Array<string> = []
	for (const match of pathTemplate.matchAll(/\{([^{}/]+)\}/g)) {
		const name = match[1]
		if (name) names.push(name)
	}
	return names
}

function fillPathTemplate(
	pathTemplate: string,
	pathParams: Record<string, string>,
): string {
	return pathTemplate.replace(/\{([^{}/]+)\}/g, (_full, name: string) => {
		const value = pathParams[name]
		if (value === undefined) {
			throw new OpenApiError(`Missing path parameter "${name}" for ${pathTemplate}.`)
		}
		return encodeURIComponent(value)
	})
}

function appendQueryParams(
	searchParams: URLSearchParams,
	query: Record<string, unknown>,
): void {
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === '') continue
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (entry === undefined || entry === null) continue
				searchParams.append(key, stringifyQueryValue(entry))
			}
			continue
		}
		searchParams.set(key, stringifyQueryValue(value))
	}
}

function stringifyQueryValue(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return JSON.stringify(value)
}

export async function searchWithApiToken(input: OpenApiClientInput & {
	query?: string
	domain?: string
	limit?: number
	entity?: string
}): Promise<ToolCallResult> {
	if (input.entity) {
		throw new OpenApiError(
			`Open API search does not support --entity yet. Run \`kody login\` and use MCP search, or omit --entity.`,
			{ status: null, code: 'unsupported' },
		)
	}
	const body = await openApiGet({
		...input,
		path: 'v1/search',
		query: {
			query: input.query,
			domain: input.domain,
			limit: input.limit,
		},
	})
	const text = JSON.stringify(body, null, 2)
	return {
		content: [{ type: 'text', text }],
		structuredContent: body,
		isError: false,
	}
}

export async function whoamiWithApiToken(
	input: OpenApiClientInput,
): Promise<{
	mcpUrl?: undefined
	apiUrl: string
	token: {
		id: string
		name: string | null
		scopes: Array<string>
		expiresAt: string | null
		maxExpiresAt: string | null
	}
	user: { userId: string; email: string; displayName: string } | null
}> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const current = (await openApiGet({
		...input,
		apiUrl,
		path: 'v1/tokens/current',
	})) as Record<string, unknown>

	let user: { userId: string; email: string; displayName: string } | null = null
	try {
		const me = (await openApiGet({
			...input,
			apiUrl,
			path: 'v1/me',
		})) as Record<string, unknown>
		user = {
			userId: String(me.user_id ?? ''),
			email: String(me.email ?? ''),
			displayName: String(me.display_name ?? ''),
		}
	} catch (error) {
		// account:read is optional; tokens/current needs no scope.
		if (!(error instanceof OpenApiError && error.status === 403)) throw error
	}

	return {
		apiUrl,
		token: {
			id: String(current.id ?? ''),
			name: typeof current.name === 'string' ? current.name : null,
			scopes: Array.isArray(current.scopes)
				? current.scopes.filter((scope): scope is string => typeof scope === 'string')
				: [],
			expiresAt: typeof current.expires_at === 'string' ? current.expires_at : null,
			maxExpiresAt: typeof current.max_expires_at === 'string' ? current.max_expires_at : null,
		},
		user,
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

function describeOpenApiFailure(status: number, body: unknown, url: URL): OpenApiError {
	const failure = readErrorBody(body)
	const code = failure?.code ?? null
	const detail = failure?.message ? ` Server said: ${failure.message}` : ''
	if (status === 401) {
		return new OpenApiError(
			`Kody rejected the API token (expired, revoked, or malformed). Mint a fresh scoped token and pass it with --token or ${apiTokenEnvVar}.${detail}`,
			{ status, code },
		)
	}
	if (status === 403 && code === 'insufficient_scope') {
		const required =
			isRecord(body) && isRecord(body.error) && isRecord(body.error.details)
				? body.error.details.required_scope
				: null
		return new OpenApiError(
			`${insufficientScopeMessage({
				requiredScope: typeof required === 'string' ? required : null,
			})}${detail}`,
			{ status, code },
		)
	}
	if (code === 'feature_disabled') {
		return new OpenApiError(`Kody returned feature_disabled.${detail}`, { status, code })
	}
	return new OpenApiError(
		failure?.message ?? `Kody API request failed with HTTP ${status} (${url.pathname}).`,
		{ status, code },
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
