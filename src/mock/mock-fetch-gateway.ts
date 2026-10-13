/**
 * Node-side mock outbound fetch gateway: match MSW handlers from
 * `.kody/mocks.ts`, optionally passthrough allowlisted hosts to real network,
 * otherwise fail closed with `unmocked_request` + a paste-ready handler stub.
 */

import { getResponse, isPassthroughResponse, type RequestHandler } from 'msw'
import { StructuredCliError } from '../structured-error.js'
import type { KodyTarget } from '../target.js'
import { loadPackageMocks } from './load-package-mocks.js'

export type MockGatewayFetchRequest = {
	url?: string
	method?: string
	headers?: Record<string, string>
	bodyBase64?: string
}

export type MockGatewayFetchResult = {
	status: number
	statusText: string
	headers: Record<string, string>
	bodyBase64: string
}

export type MockFetchGateway = {
	/** True when `.kody/mocks.ts` loaded (shim should be injected). */
	enabled: boolean
	handlers: ReadonlyArray<RequestHandler>
	passthroughHosts: ReadonlyArray<string>
	allowPrivateNetwork: boolean
	handle: (args: unknown, signal?: AbortSignal) => Promise<MockGatewayFetchResult>
}

export function parsePassthroughHosts(raw: string | undefined): Array<string> {
	if (!raw?.trim()) return []
	return [
		...new Set(
			raw
				.split(',')
				.map((part) => part.trim().toLowerCase())
				.filter(Boolean),
		),
	]
}

export function createMockFetchGateway(input: {
	handlers: ReadonlyArray<RequestHandler>
	passthroughHosts?: ReadonlyArray<string>
	allowPrivateNetwork?: boolean
	fetchFn?: typeof fetch
}): MockFetchGateway {
	const passthroughHosts = input.passthroughHosts ?? []
	const allowPrivateNetwork = input.allowPrivateNetwork === true
	const fetchFn = input.fetchFn ?? fetch
	return {
		enabled: true,
		handlers: input.handlers,
		passthroughHosts,
		allowPrivateNetwork,
		handle: async (args, signal) => {
			const request = readGatewayRequest(args)
			return await dispatchMockGatewayFetch({
				handlers: input.handlers,
				passthroughHosts,
				allowPrivateNetwork,
				request,
				fetchFn,
				signal,
			})
		},
	}
}

export async function dispatchMockGatewayFetch(input: {
	handlers: ReadonlyArray<RequestHandler>
	passthroughHosts: ReadonlyArray<string>
	allowPrivateNetwork: boolean
	request: MockGatewayFetchRequest
	fetchFn?: typeof fetch
	signal?: AbortSignal
}): Promise<MockGatewayFetchResult> {
	const method = (input.request.method ?? 'GET').toUpperCase()
	const url = String(input.request.url ?? '')
	if (!url) {
		throw new StructuredCliError({
			code: 'unmocked_request',
			message: 'Mock gatewayFetch requires request.url.',
			target: 'mock',
			fix: 'Pass an absolute URL from ambient fetch.',
		})
	}
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new StructuredCliError({
			code: 'unmocked_request',
			message: `Mock gatewayFetch URL is not absolute: ${JSON.stringify(url)}.`,
			target: 'mock',
			where: `${method} ${url}`,
			fix: 'Use an absolute https:// URL in package code under --target mock.',
		})
	}

	if (hostMatchesPassthrough(parsed.hostname, input.passthroughHosts)) {
		assertPassthroughAllowed(parsed, input.allowPrivateNetwork)
		return await realNetworkFetch({
			request: input.request,
			method,
			url: parsed.href,
			fetchFn: input.fetchFn ?? fetch,
			signal: input.signal,
		})
	}

	const headers = new Headers(input.request.headers ?? {})
	const body =
		input.request.bodyBase64 != null && input.request.bodyBase64 !== ''
			? Buffer.from(input.request.bodyBase64, 'base64')
			: undefined
	const requestInit: RequestInit = {
		method,
		headers,
		...(body !== undefined && method !== 'GET' && method !== 'HEAD'
			? { body }
			: {}),
		signal: input.signal,
	}
	const request = new Request(parsed.href, requestInit)
	const response = await getResponse([...input.handlers], request)
	if (!response || isPassthroughResponse(response)) {
		throw unmockedRequestError(method, parsed.href)
	}
	return await serializeResponse(response)
}

function readGatewayRequest(args: unknown): MockGatewayFetchRequest {
	const record =
		args && typeof args === 'object' && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: {}
	const nested =
		record.request && typeof record.request === 'object' && !Array.isArray(record.request)
			? (record.request as Record<string, unknown>)
			: record
	return {
		url: typeof nested.url === 'string' ? nested.url : undefined,
		method: typeof nested.method === 'string' ? nested.method : undefined,
		headers:
			nested.headers && typeof nested.headers === 'object' && !Array.isArray(nested.headers)
				? (nested.headers as Record<string, string>)
				: undefined,
		bodyBase64: typeof nested.bodyBase64 === 'string' ? nested.bodyBase64 : undefined,
	}
}

export function hostMatchesPassthrough(
	hostname: string,
	hosts: ReadonlyArray<string>,
): boolean {
	const target = hostname.toLowerCase()
	return hosts.some((entry) => {
		const normalized = entry.trim().toLowerCase()
		if (!normalized) return false
		if (normalized.startsWith('*.')) {
			const suffix = normalized.slice(1)
			return target.endsWith(suffix) && target.length > suffix.length
		}
		return target === normalized
	})
}

function assertPassthroughAllowed(url: URL, allowPrivateNetwork: boolean): void {
	if (allowPrivateNetwork) return
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new StructuredCliError({
			code: 'unmocked_request',
			message: `Passthrough refused for non-http(s) URL ${url.href}.`,
			target: 'mock',
			where: url.href,
		})
	}
	const host = url.hostname.toLowerCase()
	const privateHost =
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '::1' ||
		host === '[::1]' ||
		host.endsWith('.local') ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
	if (privateHost) {
		throw new StructuredCliError({
			code: 'unmocked_request',
			message: `Passthrough to private/local host ${JSON.stringify(host)} requires --allow-private-network.`,
			target: 'mock',
			where: url.href,
			fix: 'Add --allow-private-network, or mock this host in .kody/mocks.ts instead of --passthrough.',
		})
	}
}

async function realNetworkFetch(input: {
	request: MockGatewayFetchRequest
	method: string
	url: string
	fetchFn: typeof fetch
	signal?: AbortSignal
}): Promise<MockGatewayFetchResult> {
	const headers = new Headers(input.request.headers ?? {})
	// Credentials stay fake on mock — never forward opaque credential handles
	// or Authorization that would look like a real secret placement.
	headers.delete('x-kody-credential-client')
	const body =
		input.request.bodyBase64 != null && input.request.bodyBase64 !== ''
			? Buffer.from(input.request.bodyBase64, 'base64')
			: undefined
	const response = await input.fetchFn(input.url, {
		method: input.method,
		headers,
		...(body !== undefined && input.method !== 'GET' && input.method !== 'HEAD'
			? { body }
			: {}),
		signal: input.signal,
		redirect: 'manual',
	})
	return await serializeResponse(response)
}

async function serializeResponse(response: Response): Promise<MockGatewayFetchResult> {
	const bytes = new Uint8Array(await response.arrayBuffer())
	return {
		status: response.status,
		statusText: response.statusText,
		headers: Object.fromEntries(response.headers.entries()),
		bodyBase64: Buffer.from(bytes).toString('base64'),
	}
}

export function unmockedRequestError(method: string, url: string): StructuredCliError {
	const stub = buildHandlerStub(method, url)
	return new StructuredCliError({
		code: 'unmocked_request',
		message: `Unmocked ${method} ${url} under --target mock.`,
		target: 'mock',
		where: `${method} ${url}`,
		fix:
			`Add a handler in .kody/mocks.ts (or pass --passthrough ${safeHost(url)} for real network without secrets):\n\n${stub}`,
		details: { method, url, handlerStub: stub },
	})
}

export function buildHandlerStub(method: string, url: string): string {
	const verb = method.toLowerCase()
	const httpMethod = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(
		verb,
	)
		? verb
		: 'all'
	return [
		`import { http, HttpResponse } from 'msw'`,
		``,
		`export const handlers = [`,
		`  http.${httpMethod}(${JSON.stringify(url)}, () =>`,
		`    HttpResponse.json({ /* TODO */ }, { status: 200 }),`,
		`  ),`,
		`]`,
	].join('\n')
}

function safeHost(url: string): string {
	try {
		return new URL(url).hostname
	} catch {
		return 'example.com'
	}
}

/** Bridge interceptor: handle `kody.gatewayFetch` when a mock gateway is active. */
export function tryHandleMockGatewayFetchCall(input: {
	gateway: MockFetchGateway | undefined
	path: ReadonlyArray<string>
	args: ReadonlyArray<unknown>
	signal?: AbortSignal
}): Promise<MockGatewayFetchResult> | null {
	if (!input.gateway?.enabled) return null
	if (input.path.join('.') !== 'kody.gatewayFetch') return null
	return input.gateway.handle(input.args[0], input.signal)
}

/**
 * Load `.kody/mocks.ts` only for `--target mock` when the file exists.
 * Packages without the file keep native workerd fetch (no shim).
 */
export async function resolveMockFetchGateway(input: {
	target: KodyTarget
	packageRoot?: string
	passthroughHosts?: ReadonlyArray<string>
	allowPrivateNetwork?: boolean
	onStatus?: (message: string) => void
}): Promise<MockFetchGateway | undefined> {
	if (input.target !== 'mock') return undefined
	if (!input.packageRoot) return undefined
	const loaded = await loadPackageMocks(input.packageRoot)
	if (!loaded) return undefined
	input.onStatus?.(
		`Loaded ${loaded.handlers.length} MSW handler${loaded.handlers.length === 1 ? '' : 's'} from .kody/mocks.ts (outbound fetch fail-closed on mock).`,
	)
	return createMockFetchGateway({
		handlers: loaded.handlers,
		passthroughHosts: input.passthroughHosts,
		allowPrivateNetwork: input.allowPrivateNetwork,
	})
}
