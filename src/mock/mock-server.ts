/**
 * Lightweight in-process mock of the Kody production API for `--target mock`.
 * Does not ship or require kody-celld. Refuses unimplemented routes/ops with
 * `not_implemented_in_mock` rather than faking success.
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { notImplementedInMock, StructuredCliError } from '../structured-error.js'
import {
	isMockCapabilityPath,
	isMockOpenApiOperation,
	mockOpenApiOperationIds,
} from './mock-supported.js'
import {
	loadMockSession,
	packageStorageDelete,
	packageStorageGet,
	packageStorageList,
	packageStorageSet,
	persistMockSession,
	type MockSessionState,
} from './mock-storage.js'

export type MockServerOptions = {
	sessionId?: string
	resetStorage?: boolean
	host?: string
	port?: number
	/** Fixed package id for scratch packageStorage in local package runs. */
	packageId?: string
	env?: NodeJS.ProcessEnv
}

export type MockServer = {
	url: string
	port: number
	sessionId: string
	close: () => Promise<void>
	state: () => MockSessionState
}

const mockTokenPrefix = 'kody_mock_'

export function isMockApiToken(token: string): boolean {
	return token.startsWith(mockTokenPrefix) || token === 'mock'
}

/** Issue a bearer the mock accepts (never a real kody_at_…). */
export function mintMockApiToken(sessionId: string): string {
	return `${mockTokenPrefix}${sessionId}`
}

export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
	let state = await loadMockSession({
		sessionId: options.sessionId,
		env: options.env,
		reset: options.resetStorage,
	})
	const packageId = options.packageId ?? `local-${state.sessionId}`

	const server = createServer((req, res) => {
		void handleRequest(req, res, {
			getState: () => state,
			setState: async (next) => {
				state = next
				await persistMockSession(state, options.env)
			},
			packageId,
		})
	})

	const host = options.host ?? '127.0.0.1'
	const port = options.port ?? 0
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, host, () => resolve())
	})
	const address = server.address() as AddressInfo
	const url = `http://${host}:${address.port}`

	return {
		url,
		port: address.port,
		sessionId: state.sessionId,
		state: () => state,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
	}
}

/** Ensure a mock is running and return its API origin + token for CLI wiring. */
export async function ensureMockTarget(input: {
	sessionId?: string
	resetStorage?: boolean
	packageId?: string
	env?: NodeJS.ProcessEnv
	/** Reuse an already-started server (e.g. long-lived `kody dev`). */
	existing?: MockServer
}): Promise<{ apiUrl: string; token: string; server: MockServer; started: boolean }> {
	if (input.existing) {
		return {
			apiUrl: input.existing.url,
			token: mintMockApiToken(input.existing.sessionId),
			server: input.existing,
			started: false,
		}
	}
	const server = await startMockServer({
		sessionId: input.sessionId,
		resetStorage: input.resetStorage,
		packageId: input.packageId,
		env: input.env,
	})
	return {
		apiUrl: server.url,
		token: mintMockApiToken(server.sessionId),
		server,
		started: true,
	}
}

type RequestCtx = {
	getState: () => MockSessionState
	setState: (state: MockSessionState) => Promise<void>
	packageId: string
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RequestCtx,
): Promise<void> {
	try {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		const method = (req.method ?? 'GET').toUpperCase()
		const body = await readJsonBody(req)

		if (method === 'GET' && url.pathname === '/openapi.json') {
			return sendJson(res, 200, mockOpenApiDocument())
		}

		if (method === 'GET' && url.pathname === '/v1/capability-proxy/session') {
			assertMockAuth(req)
			return sendJson(res, 200, {
				scopes: ['org:execute', 'org:read', 'package:execute', 'package:read', 'search:read'],
				features: ['local-execute', 'credential-call-map'],
				expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
			})
		}

		if (method === 'POST' && url.pathname === '/v1/capability-proxy/call') {
			assertMockAuth(req)
			const path = Array.isArray(body?.path) ? (body.path as Array<string>) : null
			const args = Array.isArray(body?.args) ? (body.args as Array<unknown>) : []
			if (!path || path.length === 0) {
				return sendJson(res, 400, {
					error: { code: 'invalid_request', message: 'path is required' },
				})
			}
			const pathKey = path.join('.')
			if (!isMockCapabilityPath(pathKey)) {
				const err = notImplementedInMock({ operation: `CapabilityProxy ${pathKey}` })
				return sendJson(res, 501, { error: err.toJSON() })
			}
			try {
				const result = await dispatchCapabilityCall(pathKey, args, ctx)
				return sendJson(res, 200, { result })
			} catch (error) {
				if (error instanceof StructuredCliError) {
					return sendJson(res, 501, { error: error.toJSON() })
				}
				throw error
			}
		}

		if (method === 'POST' && url.pathname === '/v1/local-execute/package-graph') {
			assertMockAuth(req)
			// Empty module list: local unpublished code has no stamped kody:@ deps
			// from origin. Gateway-fetch shim is omitted; ambient secret placeholders
			// are unavailable on mock (use mock credentials instead).
			return sendJson(res, 200, {
				modules: [],
				compatibilityDate: '2026-04-16',
				compatibilityFlags: ['nodejs_compat'],
			})
		}

		// Open API style: GET /v1/search?query=
		if (method === 'GET' && url.pathname === '/v1/search') {
			assertMockAuth(req)
			const query = url.searchParams.get('query') ?? ''
			const entity = url.searchParams.get('entity') ?? undefined
			return sendJson(res, 200, mockSearch(ctx.getState(), { query, entity }))
		}

		if (method === 'GET' && url.pathname === '/v1/me') {
			assertMockAuth(req)
			return sendJson(res, 200, mockCurrentUser(ctx.getState()))
		}

		// Generic Open API POST /v1/... by operation is not fully routed; refuse.
		if (url.pathname.startsWith('/v1/')) {
			const err = notImplementedInMock({
				operation: `${method} ${url.pathname}`,
			})
			return sendJson(res, 501, { error: err.toJSON() })
		}

		const err = notImplementedInMock({ operation: `${method} ${url.pathname}` })
		return sendJson(res, 501, { error: err.toJSON() })
	} catch (error) {
		if (error instanceof AuthError) {
			return sendJson(res, 401, {
				error: { code: 'unauthorized', message: error.message },
			})
		}
		const message = error instanceof Error ? error.message : String(error)
		return sendJson(res, 500, {
			error: { code: 'mock_internal_error', message },
		})
	}
}

class AuthError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AuthError'
	}
}

function assertMockAuth(req: IncomingMessage): void {
	const header = req.headers.authorization
	if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
		throw new AuthError('Mock API requires Authorization: Bearer <token>.')
	}
	const token = header.slice('bearer '.length).trim()
	if (!isMockApiToken(token) && !token.startsWith('kody_at_') && token.length > 0) {
		// Accept any non-empty bearer for local bridging when callers forward a
		// login token; mock still never reaches prod secrets.
		return
	}
	if (!token) throw new AuthError('Mock API bearer token is empty.')
}

async function dispatchCapabilityCall(
	pathKey: string,
	args: Array<unknown>,
	ctx: RequestCtx,
): Promise<unknown> {
	const state = ctx.getState()
	switch (pathKey) {
		case 'kody.metaGetCurrentUser':
			return mockCurrentUser(state)
		case 'kody.search': {
			const params = (args[0] ?? {}) as { query?: string; entity?: string; limit?: number }
			return mockSearch(state, params)
		}
		case 'kody.usageGet':
			return {
				period: 'mock',
				credits: { used: 0, limit: null },
				note: 'Mock usage — not real entitlement data.',
			}
		case 'kody.execute': {
			const params = (args[0] ?? {}) as { code?: string; invoke?: string }
			throw notImplementedInMock({
				operation: 'kody.execute (cloud sandbox)',
				fix: 'Use `kody execute --local --target mock` so the module runs in local workerd against this mock.',
			})
		}
		case 'kody.__mockPackageStorageGet':
		case 'kody.packageStorageGet': {
			const key = String((args[0] as { key?: string })?.key ?? '')
			return { value: packageStorageGet(state, ctx.packageId, key) ?? null }
		}
		case 'kody.__mockPackageStorageSet':
		case 'kody.packageStorageSet': {
			const input = args[0] as { key?: string; value?: unknown }
			packageStorageSet(state, ctx.packageId, String(input?.key ?? ''), input?.value)
			await ctx.setState(state)
			return { ok: true }
		}
		case 'kody.__mockPackageStorageDelete':
		case 'kody.packageStorageDelete': {
			const key = String((args[0] as { key?: string })?.key ?? '')
			const deleted = packageStorageDelete(state, ctx.packageId, key)
			await ctx.setState(state)
			return { deleted }
		}
		case 'kody.__mockPackageStorageList':
		case 'kody.packageStorageList': {
			return { entries: packageStorageList(state, ctx.packageId) }
		}
		case 'kody.credentialClientOpen': {
			const input = (args[0] ?? {}) as { key?: string; name?: string }
			const key = String(input.key ?? input.name ?? args[0] ?? '').trim()
			const opened = openMockCredential(state, key)
			return { ok: true, value: opened }
		}
		case 'kody.credentialClientOpenAll': {
			const key = String((args[0] as { key?: string })?.key ?? '').trim()
			const matches = Object.values(state.credentials).filter(
				(cred) =>
					!key ||
					cred.name === key ||
					cred.name.toUpperCase() === key.toUpperCase() ||
					cred.id === key,
			)
			if (key && matches.length === 0) {
				return { ok: true, value: [] }
			}
			const opened = (key ? matches : Object.values(state.credentials)).map((cred) =>
				mockOpenedCredential(cred),
			)
			return { ok: true, value: opened }
		}
		case 'kody.credentialClientCheck':
			return { ok: true, value: { warnings: [], checked: args[0] ?? null, strict: false } }
		case 'kody.credentialClientRefresh':
			return { ok: true, value: { refreshed: false, mock: true } }
		case 'kody.authenticatedFetch': {
			const input = (args[0] ?? {}) as {
				providerName?: string
				request?: {
					url?: string
					method?: string
					headers?: Record<string, string>
				}
			}
			const providerName = String(input.providerName ?? '').trim() || 'unknown'
			const requestUrl = String(input.request?.url ?? '')
			const body = JSON.stringify(
				mockAuthenticatedFetchBody({
					providerName,
					url: requestUrl,
					method: String(input.request?.method ?? 'GET'),
				}),
			)
			return {
				status: 200,
				statusText: 'OK',
				headers: { 'content-type': 'application/json; charset=utf-8' },
				bodyBase64: Buffer.from(body, 'utf8').toString('base64'),
			}
		}
		case 'kody.adminUserList': {
			const params = (args[0] ?? {}) as { page?: number; limit?: number }
			return {
				users: [
					{
						id: 'user_mock',
						username: 'mock-user',
						email: 'mock@example.com',
						display_name: 'Mock User',
					},
				],
				page: typeof params.page === 'number' ? params.page : 1,
				limit: typeof params.limit === 'number' ? params.limit : 20,
				total: 1,
				mock: true,
			}
		}
		default: {
			const exhaustive: never = pathKey as never
			throw notImplementedInMock({ operation: String(exhaustive) })
		}
	}
}

function openMockCredential(
	state: MockSessionState,
	key: string,
): ReturnType<typeof mockOpenedCredential> {
	const cred =
		state.credentials[key] ??
		state.credentials[key.toUpperCase()] ??
		Object.values(state.credentials).find(
			(entry) => entry.name === key || entry.name.toUpperCase() === key.toUpperCase(),
		)
	if (!cred) {
		throw new StructuredCliError({
			code: 'missing_secret',
			message: `Mock credential ${JSON.stringify(key)} is not defined for this session.`,
			target: 'mock',
			fix: 'Add a fake credential to the mock session state or use --target prod with a real allow-listed secret.',
			details: { key },
		})
	}
	return mockOpenedCredential(cred)
}

function mockOpenedCredential(cred: MockSessionState['credentials'][string]) {
	return {
		handle: `mock-handle:${cred.id}`,
		key: cred.name,
		name: cred.name,
		scope: cred.scope ?? 'personal',
		kind: cred.kind,
		hosts: [...(cred.hosts?.length ? cred.hosts : ['example.com'])],
		hint: 'mock',
		// Never expose a real secret; mockValue stays session-local scratch only.
		metadata: { mock: true },
	}
}

/** Provider-shaped fixtures so OAuth packages can smoke end-to-end on mock. */
function mockAuthenticatedFetchBody(input: {
	providerName: string
	url: string
	method: string
}): Record<string, unknown> {
	const provider = input.providerName.toLowerCase()
	if (provider === 'linkedin' || /linkedin\.com/i.test(input.url)) {
		return {
			sub: 'mock-linkedin-sub',
			name: 'Mock LinkedIn User',
			email: 'mock-linkedin@example.com',
			picture: null,
			mock: true,
			providerName: input.providerName,
			url: input.url,
			method: input.method,
		}
	}
	return {
		mock: true,
		providerName: input.providerName,
		url: input.url,
		method: input.method,
		note: 'CLI mock authenticatedFetch fixture — not a real OAuth upstream response.',
	}
}

function mockCurrentUser(state: MockSessionState) {
	return {
		user: {
			id: 'user_mock',
			username: 'mock-user',
			email: 'mock@example.com',
		},
		org: {
			id: 'org_mock',
			slug: 'mock-org',
			name: 'Mock Org',
		},
		mockSessionId: state.sessionId,
	}
}

function mockSearch(
	state: MockSessionState,
	params: { query?: string; entity?: string; limit?: number },
) {
	if (params.entity) {
		const hit = state.searchCatalog.find(
			(item) => `${item.type}:${item.id}` === params.entity || item.id === params.entity,
		)
		return {
			conversationId: `mock-${state.sessionId}`,
			matches: hit
				? [
						{
							type: hit.type,
							id: hit.id,
							entityRef: `${hit.type}:${hit.id}`,
							title: hit.title,
							description: hit.description,
						},
					]
				: [],
			offline: false,
			warnings: [],
			guidance: 'Mock catalog — not the live Kody search index.',
		}
	}
	const q = (params.query ?? '').toLowerCase().trim()
	const matches = state.searchCatalog
		.filter(
			(item) =>
				!q ||
				item.title.toLowerCase().includes(q) ||
				item.description.toLowerCase().includes(q) ||
				item.id.toLowerCase().includes(q),
		)
		.slice(0, params.limit ?? 20)
		.map((item) => ({
			type: item.type,
			id: item.id,
			entityRef: `${item.type}:${item.id}`,
			title: item.title,
			description: item.description,
		}))
	return {
		conversationId: `mock-${state.sessionId}`,
		matches,
		offline: false,
		warnings: [],
		guidance: 'Mock catalog — not the live Kody search index.',
	}
}

function mockOpenApiDocument() {
	return {
		openapi: '3.1.0',
		info: {
			title: 'Kody API (CLI mock)',
			version: 'mock',
			description:
				'Subset document for the CLI mock. Unsupported operations refuse with not_implemented_in_mock.',
		},
		paths: {
			'/v1/search': {
				get: {
					operationId: 'search',
					summary: 'Search the mock catalog',
				},
			},
			'/v1/me': {
				get: {
					operationId: 'metaGetCurrentUser',
					summary: 'Mock current user',
				},
			},
		},
		'x-kody-mock-operations': [...mockOpenApiOperationIds],
	}
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
	const chunks: Array<Buffer> = []
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	if (chunks.length === 0) return null
	const text = Buffer.concat(chunks).toString('utf8').trim()
	if (!text) return null
	try {
		return JSON.parse(text) as Record<string, unknown>
	} catch {
		return null
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload),
	})
	res.end(payload)
}

/** Close helper used by tests and short-lived CLI commands. */
export async function withMockServer<T>(
	options: MockServerOptions,
	fn: (server: MockServer) => Promise<T>,
): Promise<T> {
	const server = await startMockServer(options)
	try {
		return await fn(server)
	} finally {
		await server.close()
	}
}

// Silence unused Server type import lint when only createServer is needed in some builds
void (null as unknown as Server)
