import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bundleLocalUserModule } from '../src/local-bundle.js'
import { listSavedPackageImports } from '../src/local-package-graph.js'

function writeFixture(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'kody-local-bundle-'))
	for (const [relative, contents] of Object.entries(files)) {
		const path = join(dir, relative)
		mkdirSync(join(path, '..'), { recursive: true })
		writeFileSync(path, contents)
	}
	return dir
}

test('bundleLocalUserModule inlines relative imports', async () => {
	const dir = writeFixture({
		'unpublished.mjs': `import { value } from './src/index.js'
export default () => value
`,
		'src/index.js': `export const value = 42
`,
	})
	const source = await bundleLocalUserModule(join(dir, 'unpublished.mjs'))
	assert.match(source, /42/)
	assert.doesNotMatch(source, /from\s+['"]\.\/src\/index\.js['"]/)
})

test('bundleLocalUserModule keeps kody:* imports external', async () => {
	const dir = writeFixture({
		'entry.ts': `import type { Foo } from 'kody:@me/pkg/types'
import { greet } from 'kody:@test/pkg/hello'
import deep from 'kody:@owner/leaf/a/b/c'
import { helper } from './helper.js'
export default async function main(p: { a?: string }): Promise<string> {
	return greet(helper(p.a ?? 'fallback')) + deep
}
`,
		'helper.js': `export function helper(value) { return value }
`,
	})
	const source = await bundleLocalUserModule(join(dir, 'entry.ts'))
	assert.match(source, /from\s+["']kody:@test\/pkg\/hello["']/)
	assert.match(source, /from\s+["']kody:@owner\/leaf\/a\/b\/c["']/)
	assert.doesNotMatch(source, /kody:@me\/pkg\/types/)
	assert.doesNotMatch(source, /from\s+['"]\.\/helper\.js['"]/)
	assert.deepEqual(new Set(await listSavedPackageImports(source)), new Set([
		'kody:@owner/leaf/a/b/c',
		'kody:@test/pkg/hello',
	]))
})

test('bundleLocalUserModule keeps node:* imports external for workerd nodejs_compat', async () => {
	const dir = writeFixture({
		'entry.mjs': `import { readFile } from 'node:fs/promises'
import path from 'node:path'
export default async () => path.join('a', await readFile('x', 'utf8'))
`,
	})
	const source = await bundleLocalUserModule(join(dir, 'entry.mjs'))
	assert.match(source, /from\s+["']node:fs\/promises["']/)
	assert.match(source, /from\s+["']node:path["']/)
})

test('bundleLocalUserModule bundles bare npm imports from node_modules', async () => {
	const dir = writeFixture({
		'entry.mjs': `import { label } from 'tiny-dep'
export default () => label
`,
		'node_modules/tiny-dep/package.json': `{"name":"tiny-dep","type":"module","main":"index.js"}
`,
		'node_modules/tiny-dep/index.js': `export const label = 'from-npm'
`,
	})
	const source = await bundleLocalUserModule(join(dir, 'entry.mjs'))
	assert.match(source, /from-npm/)
	assert.doesNotMatch(source, /from\s+['"]tiny-dep['"]/)
})

test('bundleLocalUserModule fails clearly for an unresolvable relative import', async () => {
	const dir = writeFixture({
		'entry.mjs': `import { missing } from './nope.js'
export default () => missing
`,
	})
	await assert.rejects(
		() => bundleLocalUserModule(join(dir, 'entry.mjs')),
		(error: unknown) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /Could not bundle .+entry\.mjs for local execute/)
			assert.match(error.message, /Could not resolve|nope\.js/i)
			return true
		},
	)
})

test('bundleLocalUserModule fails clearly for an unresolvable npm import', async () => {
	const dir = writeFixture({
		'entry.mjs': `import missing from 'definitely-not-installed-kody-dep'
export default () => missing
`,
	})
	await assert.rejects(
		() => bundleLocalUserModule(join(dir, 'entry.mjs')),
		(error: unknown) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /Could not bundle .+entry\.mjs for local execute/)
			assert.match(error.message, /definitely-not-installed-kody-dep/)
			assert.match(error.message, /Run `npm install`/)
			return true
		},
	)
})

test('bundleLocalUserModule tip for kody:@ failures is not npm install', async () => {
	const dir = writeFixture({
		// Force the error body to mention kody:@ (path segment) so the tip branch runs.
		'kody:@fake/entry.mjs': `import { missing } from './nope.js'
export default () => missing
`,
	})
	await assert.rejects(
		() => bundleLocalUserModule(join(dir, 'kody:@fake/entry.mjs')),
		(error: unknown) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /kody:@/)
			assert.doesNotMatch(error.message, /Run `npm install`/)
			assert.match(error.message, /\.kody\/deps\.json|localDeps|package-graph/)
			return true
		},
	)
})
