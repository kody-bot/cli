/**
 * Client-side mint of the same thin passthrough the MCP `execute.invoke`
 * shortcut writes, so token-authenticated cloud execute (CapabilityProxy →
 * `kody.execute`) can run `--invoke` without the MCP tool.
 */

const invokeLocalName = 'action'

export function parseExecuteInvokeSpecifier(raw: string): string {
	const trimmed = raw.trim()
	if (!trimmed) {
		throw new Error(
			'Unsupported execute invoke specifier. Use a kody:@scope/package/export (or @scope/package#export) package import, not a URL.',
		)
	}
	if (/:\/\//.test(trimmed) && !trimmed.startsWith('kody:@')) {
		throw new Error(
			'Unsupported execute invoke specifier. Use a kody:@scope/package/export (or @scope/package#export) package import, not a URL.',
		)
	}

	let value = trimmed
	const hashIndex = value.indexOf('#')
	if (hashIndex >= 0) {
		const before = value.slice(0, hashIndex).trim()
		const after = value
			.slice(hashIndex + 1)
			.trim()
			.replace(/^\.\//, '')
		if (!before || value.includes('#', hashIndex + 1)) {
			throw new Error(
				'Unsupported execute invoke specifier. Use a kody:@scope/package/export (or @scope/package#export) package import, not a URL.',
			)
		}
		value = after ? `${before}/${after}` : before
	}

	if (value.startsWith('@')) {
		value = `kody:${value}`
	}

	if (!value.startsWith('kody:@')) {
		throw new Error(
			'Unsupported execute invoke specifier. Use a kody:@scope/package/export (or @scope/package#export) package import, not a URL.',
		)
	}

	return value
}

export function buildExecuteInvokePassthroughSource(specifier: string): string {
	return `import ${invokeLocalName} from ${JSON.stringify(specifier)}

export default async function main(params) {
	return await ${invokeLocalName}(params)
}`
}

export function resolveExecuteInvokeCode(invoke: string): string {
	return buildExecuteInvokePassthroughSource(parseExecuteInvokeSpecifier(invoke))
}
