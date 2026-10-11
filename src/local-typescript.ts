import * as nodeModule from 'node:module'
import { basename, extname } from 'node:path'

/** Extensions whose type syntax workerd cannot parse. */
const typescriptModuleExtensions = new Set(['.ts', '.mts', '.cts'])

type StripTypeScriptTypes = (
	code: string,
	options?: { mode?: 'strip' | 'transform'; sourceUrl?: string },
) => string

let stripTypesWarningMuted = false

/**
 * Node 22.13+ prints an ExperimentalWarning the first time
 * `module.stripTypeScriptTypes` runs. Drop that one warning so local execute
 * stderr stays limited to real failures.
 */
function muteStripTypeScriptTypesExperimentalWarning(): void {
	if (stripTypesWarningMuted) return
	stripTypesWarningMuted = true
	const emitWarning = process.emitWarning
	const filtered = (warning: string | Error, ...rest: Array<unknown>) => {
		const message = typeof warning === 'string' ? warning : warning.message
		const typeName = typeof warning === 'string' ? rest[0] : warning.name
		if (typeName === 'ExperimentalWarning' && message.includes('stripTypeScriptTypes')) return
		return Reflect.apply(emitWarning, process, [warning, ...rest])
	}
	process.emitWarning = filtered as typeof process.emitWarning
}

function stripTypeScriptTypes(): StripTypeScriptTypes | undefined {
	const strip = (nodeModule as { stripTypeScriptTypes?: StripTypeScriptTypes }).stripTypeScriptTypes
	return typeof strip === 'function' ? strip : undefined
}

export function isTypeScriptModulePath(modulePath: string): boolean {
	return typescriptModuleExtensions.has(extname(modulePath).toLowerCase())
}

/**
 * Source written to workerd `main.js`.
 * `.ts`, `.mts`, and `.cts` files are type-stripped. Other paths, including
 * `--code` and `.js`, are returned unchanged.
 */
export function localUserModuleSource(code: string, modulePath?: string): string {
	if (modulePath === undefined || !isTypeScriptModulePath(modulePath)) return code
	const strip = stripTypeScriptTypes()
	if (strip === undefined) {
		throw new Error(
			`Could not strip TypeScript from ${modulePath} before local execute wrote main.js.\nThis Node.js (v${process.versions.node}) does not provide module.stripTypeScriptTypes (included in Node.js 22.13 and newer). Upgrade Node.js and retry.`,
		)
	}
	muteStripTypeScriptTypesExperimentalWarning()
	try {
		return strip(code, { mode: 'strip', sourceUrl: sourceUrlFor(modulePath) })
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(
			`Could not strip TypeScript from ${modulePath} before local execute wrote main.js.\n${detail}`,
		)
	}
}

function sourceUrlFor(modulePath: string): string | undefined {
	const name = basename(modulePath)
	if (name.length === 0 || /[\r\n]/.test(name)) return undefined
	return name
}
