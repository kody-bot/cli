import {
	assertTokenSafeApiUrl,
	capabilityProxyUrl,
	type CapabilityProxyClientInput,
} from './capability-proxy.js'
import {
	apiTokenMintInstructions,
	cliBootstrapInstructions,
	currentStoredTokenLifetimeAlias,
	featureDisabledMessage,
	insufficientScopeMessage,
	isScopedApiToken,
	readInsufficientScopeDetails,
	rejectedOauthBearerMessage,
} from './api-token.js'
import { apiTokenEnvVar, cliName } from './defaults.js'
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

/**
 * True when `index` sits inside a string literal or comment. Used so
 * doc/example snippets like `from 'kody:@scope/pkg/export'` inside a string
 * are not treated as real imports (gift-cliff-ops format/digest helpers;
 * kentcdodds/kody#2808).
 */
export function isInsideStringOrComment(code: string, index: number): boolean {
	let i = 0
	while (i < index && i < code.length) {
		const ch = code[i]!
		const next = code[i + 1]
		if (ch === '/' && next === '/') {
			i += 2
			while (i < code.length && code[i] !== '\n') i += 1
			if (i >= index) return true
			continue
		}
		if (ch === '/' && next === '*') {
			i += 2
			while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
				if (i >= index) return true
				i += 1
			}
			i += 2
			if (i > index) return true
			continue
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch
			i += 1
			while (i < code.length) {
				if (i >= index) return true
				if (code[i] === '\\') {
					i += 2
					continue
				}
				if (code[i] === quote) {
					i += 1
					break
				}
				i += 1
			}
			if (i > index) return true
			continue
		}
		i += 1
	}
	return false
}

/** Unique `kody:@…` specifiers referenced by static or literal-dynamic imports. */
export function listSavedPackageImports(code: string): Array<string> {
	const found = new Set<string>()
	for (const match of code.matchAll(staticImportPattern)) {
		if (match.index === undefined) continue
		if (isInsideStringOrComment(code, match.index)) continue
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
	for (const match of code.matchAll(/\bimport\s*\(\s*["']kody:@[^"']+["']\s*\)/g)) {
		if (match.index === undefined) continue
		if (isInsideStringOrComment(code, match.index)) continue
		return true
	}
	return false
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
/** Exact workerd module name for the origin-supplied gateway-fetch shim. */
export const localExecuteGatewayFetchShimModuleName =
	'.__kody_virtual__/runtime.js'

/**
 * Write package-graph modules into a workerd temp dir and return capnp entries.
 * Shared by execute --local, local package runs, and kody dev app bundling.
 */
export async function writePackageModuleFiles(
	workDir: string,
	graph: LocalPackageGraph,
	writeFile: (path: string, data: string) => Promise<void>,
	joinPath: (...parts: string[]) => string,
): Promise<Array<{ name: string; file: string }>> {
	const written: Array<{ name: string; file: string }> = []
	for (const [index, module] of graph.modules.entries()) {
		const file = `pkg-${index}.js`
		await writeFile(joinPath(workDir, file), module.esModule)
		written.push({ name: module.name, file })
	}
	return written
}

/**
 * Resolve stamped `kody:@` modules for local workerd.
 * On `--target mock`, capability hops stay on the mock. Dependencies resolve
 * from (1) the local working tree / `.kody/deps.json` / self-package, then
 * (2) published package-graph when `depResolve` is set (login / API token).
 * Published source is not a secret. Fresh HOME with only local deps needs no login.
 */
export async function resolveLocalPackageGraph(input: {
	code: string
	/** API used for CapabilityProxy (mock or prod). */
	apiUrl: string
	token: string
	org?: string
	fetchFn?: typeof fetch
	conversationId?: string
	/**
	 * When set (typical for --target mock), fetch stamped modules from this
	 * client instead of `apiUrl`/`token`.
	 */
	depResolve?: {
		apiUrl: string
		token: string
		org?: string
		fetchFn?: typeof fetch
	}
	/**
	 * Package directory for local / self-package `kody:@` resolution on mock
	 * (and optional `.kody/deps.json`).
	 */
	packageRoot?: string
	onStatus?: (message: string) => void
}): Promise<LocalPackageGraph> {
	const imports = listSavedPackageImports(input.code)
	// Mock package-graph is empty by design. When deps are resolved from a
	// separate prod client, skip the round-trip if there are no kody:@ imports.
	// Prod CapabilityProxy still needs package-graph for the gateway-fetch shim
	// even with zero imports — so never early-return on the prod path.
	if (
		input.depResolve &&
		imports.length === 0 &&
		!hasLiteralDynamicSavedPackageImports(input.code)
	) {
		return { modules: [], imports: [] }
	}

	let localModules: Array<LocalPackageModule> = []
	let unresolved = imports
	const { mergePackageGraphs, resolveLocalPackageModules, tryLoadSelfManifest } =
		await import('./mock-local-deps.js')
	if (imports.length > 0 && input.packageRoot) {
		const selfManifest = await tryLoadSelfManifest(input.packageRoot)
		const local = await resolveLocalPackageModules({
			code: input.code,
			packageRoot: input.packageRoot,
			selfManifest,
			onStatus: input.onStatus,
		})
		localModules = local.modules
		unresolved = local.unresolved
		// Mock: local-only graphs need no published package-graph (and no login).
		// Prod: still fetch package-graph for the origin gateway-fetch shim even
		// when every kody:@ import resolved from the working tree (Bugbot).
		if (
			unresolved.length === 0 &&
			(input.depResolve !== undefined || isLikelyMockBearer(input.token))
		) {
			return { modules: localModules, imports }
		}
	}

	if (unresolved.length > 0 && !input.depResolve && isLikelyMockBearer(input.token)) {
		throw new LocalPackageGraphError(
			`kody:@ dependencies need published package-graph while --target mock keeps storage/credentials local. ` +
				`Map them in .kody/deps.json (or package.json#kody.localDeps), keep them in this package's exports, ` +
				`or log in (\`kody login\` / \`kody auth bootstrap\`) / set KODY_API_TOKEN so the CLI can fetch dependency source from prod. ` +
				`Unresolved: ${unresolved.join(', ')}`,
			{ code: 'mock_package_deps_need_auth' },
		)
	}
	const client = input.depResolve
		? {
				apiUrl: input.depResolve.apiUrl,
				token: input.depResolve.token,
				fetchFn: input.depResolve.fetchFn ?? input.fetchFn,
				...(input.depResolve.org ? { org: input.depResolve.org } : {}),
			}
		: {
				apiUrl: input.apiUrl,
				token: input.token,
				fetchFn: input.fetchFn,
				...(input.org ? { org: input.org } : {}),
			}
	if (input.depResolve && unresolved.length > 0) {
		input.onStatus?.(
			`Resolving ${unresolved.length} kody:@ dependenc${unresolved.length === 1 ? 'y' : 'ies'} from published package-graph (mock keeps storage/credentials local)…`,
		)
	}
	const published = await fetchLocalPackageGraph({
		...client,
		code: input.code,
		conversationId: input.conversationId,
		...(localModules.length > 0 ? { requiredImports: unresolved } : {}),
	})
	if (localModules.length === 0) return published
	return mergePackageGraphs(localModules, published)
}

function isLikelyMockBearer(token: string): boolean {
	return token === 'mock' || token.startsWith('kody_mock_')
}

export async function fetchLocalPackageGraph(
	input: CapabilityProxyClientInput & {
		code: string
		conversationId?: string
		/**
		 * When some imports were already resolved locally, only require these
		 * remaining specifiers in the published graph response.
		 */
		requiredImports?: Array<string>
	},
): Promise<LocalPackageGraph> {
	assertTokenSafeApiUrl(input.apiUrl)
	const imports = listSavedPackageImports(input.code)
	const required = input.requiredImports ?? imports
	if (hasLiteralDynamicSavedPackageImports(input.code)) {
		throw new LocalPackageGraphError(
			`Local execute cannot bind literal dynamic import("kody:@…") yet — use a static import, or wait for runtime package resolution (${localPackageGraphPlatformIssueUrl}).`,
			{ code: 'unsupported_dynamic_package_import' },
		)
	}

	const url = capabilityProxyUrl(input.apiUrl, localPackageGraphPath)
	if (input.org) url.searchParams.set('org', input.org)
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
				imports: required,
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
		throw describePackageGraphFailure(response.status, body, url, required, input.token)
	}

	const graph = parsePackageGraphBody(body, required)
	const missing = required.filter(
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
	token: string,
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
		// Same wording as CapabilityProxy session 401 — package-graph is now the auth gate.
		const message = isScopedApiToken(token)
			? `Kody rejected the API token (expired, revoked, or malformed). Mint a fresh scoped token and pass it with --token or ${apiTokenEnvVar}.${detail}`
			: `${rejectedOauthBearerMessage()}${detail}`
		return new LocalPackageGraphError(message, { status, code })
	}
	if (code === 'feature_disabled') {
		return new LocalPackageGraphError(
			`${featureDisabledMessage()}${detail}`,
			{ status, code },
		)
	}
	if (code === 'insufficient_scope') {
		return new LocalPackageGraphError(
			`${insufficientScopeMessage({
				...readInsufficientScopeDetails(body),
				currentLifetime: currentStoredTokenLifetimeAlias(url.origin),
			})}${detail}`,
			{ status, code },
		)
	}
	if (status === 403) {
		return new LocalPackageGraphError(
			`The API token is not allowed to use CapabilityProxy${code ? ` (${code})` : ''}. ${cliBootstrapInstructions()} (lifetime short|long). ${apiTokenMintInstructions()}${detail}`,
			{ status, code },
		)
	}
	if (
		code === 'package_import_unresolved' ||
		code === 'not_found' ||
		status === 400 ||
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
