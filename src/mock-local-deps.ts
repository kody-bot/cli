/**
 * Resolve `kody:@` modules from the local working tree on `--target mock` so
 * unpublished dependency changes and fresh HOMEs (no login) can still run.
 *
 * Sources (in order):
 * 1. Self-package: imports of `kody:@<this-package-name>/…`
 * 2. `.kody/deps.json` or `package.json#kody.localDeps` path map
 * 3. Remaining imports fall through to published package-graph (when auth exists)
 */

import { access, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { bundleLocalUserModule } from './local-bundle.js'
import type { LocalPackageGraph, LocalPackageModule } from './local-package-graph.js'
import {
	hasLiteralDynamicSavedPackageImports,
	listSavedPackageImports,
	LocalPackageGraphError,
} from './local-package-graph.js'
import {
	loadPackageManifest,
	resolveExportModulePath,
	type KodyPackageManifest,
} from './package-manifest.js'

export type LocalDepMap = Record<string, string>

/** Relative path for the optional local-deps map file. */
export const localDepsRelativePath = '.kody/deps.json'

/**
 * Parse `kody:@scope/name/export` → `{ packageName: '@scope/name', exportKey }`.
 * Export key is `.` when the specifier is exactly the package, else `./rest`.
 */
export function parseKodyPackageSpecifier(specifier: string): {
	packageName: string
	exportKey: string
} | null {
	if (!specifier.startsWith('kody:@')) return null
	const rest = specifier.slice('kody:'.length)
	// Scoped packages: @scope/name[/export…]; unscoped: name[/export…]
	const nameEnd = rest.startsWith('@')
		? (() => {
				const scopeSlash = rest.indexOf('/')
				if (scopeSlash === -1) return -1
				return rest.indexOf('/', scopeSlash + 1)
			})()
		: rest.indexOf('/')
	if (nameEnd === -1) {
		return { packageName: rest, exportKey: '.' }
	}
	const packageName = rest.slice(0, nameEnd)
	const exportPath = rest.slice(nameEnd + 1)
	return {
		packageName,
		exportKey: exportPath ? `./${exportPath}` : '.',
	}
}

export async function loadLocalDepMap(packageRoot: string): Promise<LocalDepMap> {
	const fromFile = await readDepsJson(join(packageRoot, localDepsRelativePath))
	const fromManifest = await readDepsFromPackageJson(packageRoot)
	return { ...fromManifest, ...fromFile }
}

async function readDepsJson(path: string): Promise<LocalDepMap> {
	try {
		const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
		const out: LocalDepMap = {}
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof value === 'string' && value.trim()) out[normalizeDepKey(key)] = value.trim()
		}
		return out
	} catch {
		return {}
	}
}

async function readDepsFromPackageJson(packageRoot: string): Promise<LocalDepMap> {
	try {
		const raw = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
			kody?: { localDeps?: Record<string, unknown> }
		}
		const map = raw.kody?.localDeps
		if (!map || typeof map !== 'object') return {}
		const out: LocalDepMap = {}
		for (const [key, value] of Object.entries(map)) {
			if (typeof value === 'string' && value.trim()) out[normalizeDepKey(key)] = value.trim()
		}
		return out
	} catch {
		return {}
	}
}

function normalizeDepKey(key: string): string {
	const trimmed = key.trim()
	if (trimmed.startsWith('kody:')) return trimmed.slice('kody:'.length)
	return trimmed
}

function resolveDepRoot(
	packageRoot: string,
	depKey: string,
	map: LocalDepMap,
): string | undefined {
	const normalized = normalizeDepKey(depKey)
	const rel = map[normalized] ?? map[`kody:${normalized}`]
	if (!rel) return undefined
	return isAbsolute(rel) ? rel : resolve(packageRoot, rel)
}

/**
 * Bundle locally-resolvable `kody:@` imports. Returns modules plus the list of
 * imports that still need published package-graph.
 */
export async function resolveLocalPackageModules(input: {
	code: string
	packageRoot?: string
	/** Current package manifest when running inside a package directory. */
	selfManifest?: KodyPackageManifest
	onStatus?: (message: string) => void
}): Promise<{ modules: Array<LocalPackageModule>; unresolved: Array<string> }> {
	const imports = listSavedPackageImports(input.code)
	if (imports.length === 0) {
		return { modules: [], unresolved: [] }
	}
	if (hasLiteralDynamicSavedPackageImports(input.code)) {
		throw new LocalPackageGraphError(
			`Local execute cannot bind literal dynamic import("kody:@…") yet — use a static import.`,
			{ code: 'unsupported_dynamic_package_import' },
		)
	}

	const packageRoot = input.packageRoot ?? input.selfManifest?.root
	const depMap = packageRoot ? await loadLocalDepMap(packageRoot) : {}
	const selfManifest = input.selfManifest
	const modules: Array<LocalPackageModule> = []
	const unresolved: Array<string> = []
	const seen = new Set<string>()

	async function resolveOne(specifier: string): Promise<void> {
		if (seen.has(specifier)) return
		seen.add(specifier)
		const parsed = parseKodyPackageSpecifier(specifier)
		if (!parsed) {
			unresolved.push(specifier)
			return
		}

		let manifest: KodyPackageManifest | undefined
		if (selfManifest && parsed.packageName === selfManifest.name) {
			manifest = selfManifest
		} else if (packageRoot) {
			const depRoot = resolveDepRoot(packageRoot, parsed.packageName, depMap)
			if (depRoot) {
				try {
					await access(join(depRoot, 'package.json'))
					manifest = await loadPackageManifest(depRoot)
				} catch {
					throw new LocalPackageGraphError(
						`Local dep ${JSON.stringify(parsed.packageName)} points at ${JSON.stringify(depRoot)} but no package.json was found.`,
						{ code: 'local_dep_missing' },
					)
				}
			}
		}

		if (!manifest) {
			unresolved.push(specifier)
			return
		}

		let modulePath: string
		try {
			modulePath = resolveExportModulePath(manifest, parsed.exportKey)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new LocalPackageGraphError(
				`Could not resolve local ${specifier}: ${message}`,
				{ code: 'local_dep_export_missing' },
			)
		}
		input.onStatus?.(`Bundling local dep ${specifier} from ${modulePath}…`)
		const esModule = await bundleLocalUserModule(modulePath)
		modules.push({ name: specifier, esModule })
		for (const nested of listSavedPackageImports(esModule)) {
			await resolveOne(nested)
		}
	}

	for (const specifier of imports) {
		await resolveOne(specifier)
	}

	return { modules, unresolved }
}

/** Merge local modules ahead of published package-graph modules (local wins). */
export function mergePackageGraphs(
	local: Array<LocalPackageModule>,
	published: LocalPackageGraph,
): LocalPackageGraph {
	const byName = new Map<string, LocalPackageModule>()
	for (const module of published.modules) byName.set(module.name, module)
	for (const module of local) byName.set(module.name, module)
	return {
		modules: [...byName.values()],
		imports: [
			...new Set([...published.imports, ...local.map((module) => module.name)]),
		],
	}
}

/** True when `packageRoot` looks like a package we can load a manifest from. */
export async function tryLoadSelfManifest(
	cwd: string,
): Promise<KodyPackageManifest | undefined> {
	try {
		return await loadPackageManifest(cwd)
	} catch {
		return undefined
	}
}

/** Re-export dirname helper for tests. */
export function packageRootOf(manifestPath: string): string {
	return dirname(manifestPath)
}
