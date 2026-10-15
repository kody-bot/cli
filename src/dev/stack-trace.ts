/**
 * Turn a workerd V8 stack (frames point into the bundled `main.js`) into one
 * that points at the author's `.ts` sources, without runtime wrapper frames.
 */

import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'

const internalModules = new Set([
	'__kody_local_entry.js',
	'kody:runtime',
	'.__kody_runtime__.js',
	'runtime.js',
	'entry.js',
])

const framePattern = /^(\s*at\s+)(?:(.*?)\s+\()?([^()\s]+?):(\d+):(\d+)\)?\s*$/

export type StackMapper = (stack: string) => string

export function createStackMapper(input: {
	/** esbuild source map JSON for the user module, sources relative to the package root. */
	sourceMap: string | null
	/** Module name of the bundled user code inside workerd. */
	userModule: string
}): StackMapper {
	let map: TraceMap | null = null
	if (input.sourceMap) {
		try {
			map = new TraceMap(input.sourceMap)
		} catch {
			map = null
		}
	}
	return (stack) => {
		const out: Array<string> = []
		for (const line of stack.split('\n')) {
			if (!/^\s*at\s/.test(line)) {
				out.push(line)
				continue
			}
			const match = framePattern.exec(line)
			if (!match) continue
			const [, lead, fn, file, lineText, colText] = match
			const module = file!.replace(/^file:\/\/\//, '').replace(/^\//, '')
			if (internalModules.has(module)) continue
			const fnPart = fn ? `${fn} (` : ''
			const close = fn ? ')' : ''
			if (map && module === input.userModule) {
				const original = originalPositionFor(map, {
					line: Number(lineText),
					column: Number(colText) - 1,
				})
				if (original.source && original.line !== null) {
					const name = fn ?? original.name
					out.push(
						`${lead}${name ? `${name} (` : ''}${original.source}:${original.line}:${(original.column ?? 0) + 1}${name ? ')' : ''}`,
					)
					continue
				}
			}
			out.push(`${lead}${fnPart}${file}:${lineText}:${colText}${close}`)
		}
		return out.join('\n')
	}
}
