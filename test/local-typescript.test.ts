import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listSavedPackageImports } from '../src/local-package-graph.js'
import { isTypeScriptModulePath, localUserModuleSource } from '../src/local-typescript.js'

const typedModule = `import type { Foo } from 'kody:@me/pkg/types'
import { type Bar, greet } from 'kody:@test/pkg/hello'
export default async function main(p: { a?: string }): Promise<string> {
	const value: string = p.a ?? 'fallback'
	return value
}
`

test('isTypeScriptModulePath matches .ts, .mts, and .cts only', () => {
	assert.equal(isTypeScriptModulePath('x.ts'), true)
	assert.equal(isTypeScriptModulePath('dir/scan-step.TS'), true)
	assert.equal(isTypeScriptModulePath('mod.mts'), true)
	assert.equal(isTypeScriptModulePath('mod.cts'), true)
	assert.equal(isTypeScriptModulePath('mod.js'), false)
	assert.equal(isTypeScriptModulePath('mod.tsx'), false)
	assert.equal(isTypeScriptModulePath('-'), false)
})

test('localUserModuleSource strips type annotations and type-only imports', () => {
	const stderr: Array<string> = []
	const write = process.stderr.write.bind(process.stderr)
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: Array<unknown>) => {
		stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
		return Reflect.apply(write, process.stderr, [chunk, ...rest]) as boolean
	}) as typeof process.stderr.write
	let source = ''
	try {
		source = localUserModuleSource(typedModule, 'scan-step.ts')
	} finally {
		process.stderr.write = write as typeof process.stderr.write
	}
	assert.match(source, /function main\(p\s+\)/)
	assert.doesNotMatch(source, /string/)
	assert.doesNotMatch(source, /Promise/)
	assert.match(source, /sourceURL=scan-step\.ts/)
	assert.deepEqual(listSavedPackageImports(source), ['kody:@test/pkg/hello'])
	assert.equal(stderr.join('').includes('stripTypeScriptTypes'), false)
})

test('localUserModuleSource strips .mts and .cts the same way', () => {
	const code = 'export default function main(p: { a?: string }) { return p }\n'
	for (const modulePath of ['mod.mts', 'dir/mod.cts']) {
		const source = localUserModuleSource(code, modulePath)
		assert.match(source, /function main\(p\s+\)/)
		assert.doesNotMatch(source, /string/)
	}
})

test('localUserModuleSource leaves .js, stdin, and --code unchanged', () => {
	const code = 'export default (p: { a?: string }) => p\n'
	assert.equal(localUserModuleSource(code, 'task.js'), code)
	assert.equal(localUserModuleSource(code, '-'), code)
	assert.equal(localUserModuleSource(code), code)
})

test('localUserModuleSource throws the strip diagnostic when erasure fails', () => {
	assert.throws(
		() =>
			localUserModuleSource(
				'enum Color { Red = 1 }\nexport default () => Color.Red\n',
				'scan-step.ts',
			),
		(error: unknown) => {
			assert.ok(error instanceof Error)
			assert.match(
				error.message,
				/Could not strip TypeScript from scan-step\.ts before local execute wrote main\.js/,
			)
			assert.match(error.message, /enum/i)
			return true
		},
	)
})
