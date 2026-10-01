import {
	assertTokenSafeApiUrl,
	capabilityProxyUrl,
	type CapabilityProxyClientInput,
} from './capability-proxy.js'
import { cliName } from './defaults.js'
import { describeNetworkError } from './network-error.js'
import { readPackageVersion } from './package-info.js'

/**
 * Open API contract for downloading stamped `kody:@…` modules so
 * `execute --local` can embed them in workerd (no whole-module cloud execute).
 *
 * Platform tracking: https://github.com/kentcdodds/kody/issues/2808
 * TODO(kody#2808): keep this path + response shape aligned with the shipped API.
 */
export const localPackageGraphPath = 'v1/local-execute/package-graph'

/** Linked from user-facing errors when the package-graph API is missing or blocked. */
export const localPackageGraphPlatformIssueUrl =
	'https://github.com/kentcdodds/kody/issues/2808'

export type LocalPackageModule = {
	/** Exact workerd / Worker Loader module name (often a `kody:@…` specifier). */
	name: string
	/** ESM source embedded in the local workerd config. */
	esModule: string
}

export type LocalPackageGraph = {
	modules: Array<LocalPackageModule>
	imports: Array<string>
}

const staticImportPattern =
	/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](kody:@[^"']+)["']/g

/** Unique `kody:@…` specifiers referenced by static or literal-dynamic imports. */
export function listSavedPackageImports(code: string): Array<string> {
	const found = new Set<string>()
	for (const match of code.matchAll(staticImportPattern)) {
		const specifier = match[1]
		if (specifier) found.add(specifier)
	}
	return [...found]
}

export function hasSavedPackageImports(code: string): boolean {
	return listSavedPackageImports(code).length > 0
}

/**
 * Literal `import("kody:@…")` (or `import('kody:@…')`) — static `from` imports
 * are fine; computed `import(specifier)` cannot be bound into workerd ahead of
 * time without a runtime resolver.
 */
export function hasLiteralDynamicSavedPackageImports(code: string): boolean {
	return /\bimport\s*\(\s*["']kody:@[^"']+["']\s*\)/.test(code)
}

export class LocalPackageGraphError extends Error {
	readonly status: number | null
	readonly code: string | null

	constructor(
		message: string,
		options: { status?: number | null; code?: string | null } = {},
	) {
		super(message)
		this.name = 'LocalPackageGraphError'
		this.status = options.status ?? null
		this.code = options.code ?? null
	}
}

/**
 * Fetch published, stamped package modules for local workerd embedding.
 * Never falls back to CapabilityProxy → `kody.execute`.
 */
export async function fetchLocalPackageGraph(
	input: CapabilityProxyClientInput & { code: string; conversationId?: string },
): Promise<LocalPackageGraph> {
	assertTokenSafeApiUrl(input.apiUrl)
	const imports = listSavedPackageImports(input.code)
	if (imports.length === 0) {
		return { modules: [], imports: [] }
	}
	if (hasLiteralDynamicSavedPackageImports(input.code)) {
		throw new LocalPackageGraphError(
			`Local execute cannot bind literal dynamic import("kody:@…") yet — use a static import, or wait for runtime package resolution (${localPackageGraphPlatformIssueUrl}).`,
			{ code: 'unsupported_dynamic_package_import' },
		)
	}

	const url = capabilityProxyUrl(input.apiUrl, localPackageGraphPath)
	const fetchFn = input.fetchFn ?? fetch
	let response: Response
	try {
		response = await fetchFn(url, {
			method: 'POST',
			signal: input.signal,
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				authorization: `Bearer ${input.token}`,
				'user-agent': `${cliName}/${readPackageVersion()}`,
			},
			body: JSON.stringify({
				code: input.code,
				imports,
				...(input.conversationId !== undefined
					? { conversationId: input.conversationId }
					: {}),
			}),
		})
	} catch (error) {
		const reason = describeNetworkError(error)
		throw new LocalPackageGraphError(
			`Could not reach the Kody API at ${url.origin} (${reason}). Check --api-url / KODY_API_URL and your network.`,
		)
	}

	const body = await readJson(response)
	if (!response.ok) {
		throw describePackageGraphFailure(response.status, body, url, imports)
	}

	const graph = parsePackageGraphBody(body, imports)
	const missing = imports.filter(
		(specifier) => !graph.modules.some((module) => module.name === specifier),
	)
	if (missing.length > 0) {
		throw new LocalPackageGraphError(
			`Local package graph response omitted modules for: ${missing.join(', ')}. ${localPackageGraphPlatformIssueUrl}`,
			{ code: 'incomplete_package_graph' },
		)
	}
	return graph
}

function parsePackageGraphBody(body: unknown, imports: Array<string>): LocalPackageGraph {
	if (!isRecord(body) || !Array.isArray(body.modules)) {
		throw new LocalPackageGraphError(
			`Kody package-graph response was missing a modules array. ${localPackageGraphPlatformIssueUrl}`,
			{ code: 'invalid_package_graph' },
		)
	}
	const modules: Array<LocalPackageModule> = []
	for (const entry of body.modules) {
		if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()) {
			throw new LocalPackageGraphError(
				`Kody package-graph response included a module without a name. ${localPackageGraphPlatformIssueUrl}`,
				{ code: 'invalid_package_graph' },
			)
		}
		const esModule =
			typeof entry.esModule === 'string'
				? entry.esModule
				: typeof entry.source === 'string'
					? entry.source
					: typeof entry.js === 'string'
						? entry.js
						: null
		if (esModule === null) {
			throw new LocalPackageGraphError(
				`Kody package-graph module ${JSON.stringify(entry.name)} was missing esModule source. ${localPackageGraphPlatformIssueUrl}`,
				{ code: 'invalid_package_graph' },
			)
		}
		modules.push({ name: entry.name, esModule })
	}
	const reportedImports = Array.isArray(body.imports)
		? body.imports.filter((value): value is string => typeof value === 'string')
		: imports
	return { modules, imports: reportedImports }
}

function describePackageGraphFailure(
	status: number,
	body: unknown,
	url: URL,
	imports: Array<string>,
): LocalPackageGraphError {
	const failure = readErrorBody(body)
	const code = failure?.code ?? null
	const detail = failure?.message ? ` Server said: ${failure.message}` : ''
	const importList = imports.join(', ')

	if (status === 404) {
		return new LocalPackageGraphError(
			`Local execute cannot resolve saved package imports (${importList}): Kody has no package-graph endpoint at ${url.pathname} yet. ` +
				`The CLI will not silently fall back to cloud kody.execute for --local. ` +
				`Platform work: ${localPackageGraphPlatformIssueUrl}.${detail}`,
			{ status, code: code ?? 'not_found' },
		)
	}
	if (status === 401) {
		return new LocalPackageGraphError(
			`Kody rejected the API token while fetching the local package graph.${detail}`,
			{ status, code },
		)
	}
	if (code === 'feature_disabled') {
		return new LocalPackageGraphError(
			`Kody returned feature_disabled while fetching the local package graph.${detail}`,
			{ status, code },
		)
	}
	if (code === 'insufficient_scope') {
		return new LocalPackageGraphError(
			`The API token is missing a scope required to fetch the local package graph.${detail}`,
			{ status, code },
		)
	}
	if (
		code === 'package_import_unresolved' ||
		code === 'not_found' ||
		status === 400 ||
		status === 403 ||
		status === 422
	) {
		return new LocalPackageGraphError(
			failure?.message ??
				`Could not resolve saved package import(s) for local bundling (${importList}).${detail}`,
			{ status, code },
		)
	}
	return new LocalPackageGraphError(
		failure?.message ??
			`Kody package-graph request failed with HTTP ${status} (${url.pathname}).${detail}`,
		{ status, code },
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
	if (!isRecord(body) || body.error == null) return null
	const { error } = body
	if (typeof error === 'string') return { code: null, message: error }
	if (isRecord(error)) {
		const code = typeof error.code === 'string' ? error.code : null
		const message =
			typeof error.message === 'string' ? error.message : (code ?? JSON.stringify(error))
		return { code, message }
	}
	return { code: null, message: String(error) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
