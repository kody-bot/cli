import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	fetchLocalPackageGraph,
	hasLiteralDynamicSavedPackageImports,
	hasSavedPackageImports,
	listSavedPackageImports,
	LocalPackageGraphError,
	localPackageGraphPath,
	localPackageGraphPlatformIssueUrl,
} from '../src/local-package-graph.js'

const goodToken = 'kody_tok_pkg'

test('listSavedPackageImports finds static and literal-dynamic kody:@ specifiers', () => {
	assert.deepEqual(listSavedPackageImports(`import skill from 'kody:@me/skills/get'`), [
		'kody:@me/skills/get',
	])
	assert.deepEqual(
		listSavedPackageImports(`const m = await import("kody:@me/skills/get")`),
		['kody:@me/skills/get'],
	)
	assert.deepEqual(
		listSavedPackageImports(`
import { a } from 'kody:@a/pkg/one'
import b from "kody:@b/pkg/two"
export default async () => {
  const c = await import('kody:@a/pkg/one')
  return c
}`),
		['kody:@a/pkg/one', 'kody:@b/pkg/two'],
	)
	assert.equal(hasSavedPackageImports(`import { kody } from 'kody:runtime'`), false)
	assert.equal(hasLiteralDynamicSavedPackageImports(`import x from 'kody:@me/p/e'`), false)
	assert.equal(
		hasLiteralDynamicSavedPackageImports(`await import('kody:@me/p/e')`),
		true,
	)
})

test('fetchLocalPackageGraph rejects literal dynamic kody:@ imports before calling the API', async () => {
	const code = `const m = await import('kody:@me/skills/get')
export default async () => m`
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'http://127.0.0.1:9',
				token: goodToken,
				code,
				fetchFn: async () => {
					throw new Error('should not fetch')
				},
			}),
		(error: unknown) => {
			assert.ok(error instanceof LocalPackageGraphError)
			assert.match(error.message, /literal dynamic import/)
			assert.match(error.message, /2808/)
			assert.equal(error.code, 'unsupported_dynamic_package_import')
			return true
		},
	)
})

test('fetchLocalPackageGraph posts code + imports and returns embeddable modules', async () => {
	const code = `import { greet } from 'kody:@test/pkg/hello'
export default async function main(params) { return greet(params.name) }`
	const requests: Array<{ url: string; body: unknown; authorization: string | null }> = []
	const result = await fetchLocalPackageGraph({
		apiUrl: 'https://api.kody.codes',
		token: goodToken,
		code,
		conversationId: 'conv-pkg',
		fetchFn: async (input, init) => {
			const url = String(input)
			const body = init?.body ? JSON.parse(String(init.body)) : null
			requests.push({
				url,
				body,
				authorization: (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
			})
			assert.equal(init?.method, 'POST')
			return new Response(
				JSON.stringify({
					imports: ['kody:@test/pkg/hello'],
					modules: [
						{
							name: 'kody:@test/pkg/hello',
							esModule: 'export function greet(name) { return "hi " + name }\n',
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		},
	})
	assert.equal(requests.length, 1)
	assert.match(requests[0]!.url, new RegExp(`${localPackageGraphPath}$`))
	assert.equal(requests[0]!.authorization, `Bearer ${goodToken}`)
	assert.deepEqual(requests[0]!.body, {
		code,
		imports: ['kody:@test/pkg/hello'],
		conversationId: 'conv-pkg',
	})
	assert.deepEqual(result, {
		imports: ['kody:@test/pkg/hello'],
		modules: [
			{
				name: 'kody:@test/pkg/hello',
				esModule: 'export function greet(name) { return "hi " + name }\n',
			},
		],
	})
})

test('fetchLocalPackageGraph fails clearly when the platform endpoint is missing', async () => {
	const code = `import x from 'kody:@missing/pkg/export'\nexport default async () => x`
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'https://api.kody.codes',
				token: goodToken,
				code,
				fetchFn: async () =>
					new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), {
						status: 404,
						headers: { 'content-type': 'application/json' },
					}),
			}),
		(error: unknown) => {
			assert.ok(error instanceof LocalPackageGraphError)
			assert.equal(error.status, 404)
			assert.match(error.message, /will not silently fall back to cloud kody\.execute/)
			assert.match(error.message, new RegExp(localPackageGraphPlatformIssueUrl.replace(/\./g, '\\.')))
			assert.match(error.message, /kody:@missing\/pkg\/export/)
			return true
		},
	)
})

test('fetchLocalPackageGraph surfaces unresolved package errors from the API', async () => {
	const code = `import x from 'kody:@nope/pkg/export'\nexport default async () => x`
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'https://api.kody.codes',
				token: goodToken,
				code,
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							error: {
								code: 'package_import_unresolved',
								message: 'Could not resolve saved package import kody:@nope/pkg/export.',
							},
						}),
						{ status: 422, headers: { 'content-type': 'application/json' } },
					),
			}),
		/Could not resolve saved package import kody:@nope\/pkg\/export/,
	)
})

test('fetchLocalPackageGraph rejects incomplete module lists', async () => {
	const code = `import x from 'kody:@a/pkg/one'\nexport default async () => x`
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'https://api.kody.codes',
				token: goodToken,
				code,
				fetchFn: async () =>
					new Response(JSON.stringify({ modules: [{ name: 'other', esModule: 'export {}' }] }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
			}),
		/omitted modules for: kody:@a\/pkg\/one/,
	)
})
