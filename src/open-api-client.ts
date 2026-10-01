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

export async function openApiGet(
	input: OpenApiClientInput & { path: string; query?: Record<string, string | number | undefined> },
): Promise<unknown> {
	const apiUrl = input.apiUrl || defaultApiUrl
	assertTokenSafeApiUrl(apiUrl)
	const url = capabilityProxyUrl(apiUrl, input.path)
	if (input.query) {
		for (const [key, value] of Object.entries(input.query)) {
			if (value === undefined || value === '') continue
			url.searchParams.set(key, String(value))
		}
	}
	const fetchFn = input.fetchFn ?? fetch
	let response: Response
	try {
		response = await fetchFn(url, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${input.token}`,
				'user-agent': `${cliName}/${readPackageVersion()}`,
			},
		})
	} catch (error) {
		const reason = describeNetworkError(error)
		throw new OpenApiError(
			`Could not reach the Kody API at ${url.origin} (${reason}). Check --api-url / KODY_API_URL and your network.`,
		)
	}
	const body = await readJson(response)
	if (!response.ok) {
		throw describeOpenApiFailure(response.status, body, url)
	}
	return body
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
