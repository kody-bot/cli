/**
 * Regression tests for the 1.20.1 --target mock retest (MSW gateway, storage,
 * local deps, prod-shaped fixtures, CLI UX).
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { test } from 'node:test'
import {
	createMockFetchGateway,
	dispatchMockGatewayFetch,
	tryHandleMockGatewayFetchCall,
} from '../src/mock/mock-fetch-gateway.js'
import { loadPackageMocks } from '../src/mock/load-package-mocks.js'
import {
	ensureMockTarget,
	mintMockApiToken,
	withMockServer,
} from '../src/mock/mock-server.js'
import {
	parseKodyPackageSpecifier,
	resolveLocalPackageModules,
} from '../src/mock-local-deps.js'
import { listSavedPackageImports } from '../src/local-package-graph.js'
import { StructuredCliError } from '../src/structured-error.js'
import { resolveExportModulePath, loadPackageManifest } from '../src/package-manifest.js'

test('P1: authenticatedFetch and gatewayFetch go through MSW handlers', async () => {
	const handlers = [
		http.post('https://api.github.com/graphql', async ({ request }) => {
			const body = (await request.json()) as { query?: string }
			return HttpResponse.json({
				data: { viewer: { login: 'msw-user' }, query: body.query ?? null },
			})
		}),
	]
	const gateway = createMockFetchGateway({ handlers })

	const auth = await tryHandleMockGatewayFetchCall({
		gateway,
		path: ['kody', 'authenticatedFetch'],
		args: [
			{
				providerName: 'github-bot',
				request: {
					url: 'https://api.github.com/graphql',
					method: 'POST',
					bodyBase64: Buffer.from(
						JSON.stringify({ query: '{ viewer { login } }' }),
						'utf8',
					).toString('base64'),
				},
			},
		],
	})
	assert.ok(auth)
	const authResult = await auth
	assert.equal(authResult.status, 200)
	const authBody = JSON.parse(
		Buffer.from(authResult.bodyBase64, 'base64').toString('utf8'),
	) as { data: { viewer: { login: string } } }
	assert.equal(authBody.data.viewer.login, 'msw-user')

	const gw = await tryHandleMockGatewayFetchCall({
		gateway,
		path: ['kody', 'gatewayFetch'],
		args: [
			{
				request: {
					url: 'https://api.github.com/graphql',
					method: 'POST',
					bodyBase64: Buffer.from('{}', 'utf8').toString('base64'),
				},
			},
		],
	})
	assert.ok(gw)
	assert.equal((await gw).status, 200)
})

test('P1/P3: unmocked authenticatedFetch fails closed (no placeholder stub)', async () => {
	const gateway = createMockFetchGateway({ handlers: [], passthroughAll: true })
	await assert.rejects(
		async () => {
			const pending = tryHandleMockGatewayFetchCall({
				gateway,
				path: ['kody', 'authenticatedFetch'],
				args: [
					{
						providerName: 'github-bot',
						request: { url: 'https://api.github.com/graphql', method: 'POST' },
					},
				],
			})
			assert.ok(pending)
			await pending
		},
		(error: unknown) => {
			assert.ok(error instanceof StructuredCliError)
			assert.equal(error.code, 'unmocked_request')
			return true
		},
	)
})

test('P1: mock storage packageId is shared across ensureMockTarget callers', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-storage-'))
	const env = { KODY_CACHE_DIR: cache }
	try {
		const packageId = 'local:platform-feedback-triage'
		const first = await ensureMockTarget({
			sessionId: 'shared',
			packageId,
			resetStorage: true,
			env,
		})
		const token = mintMockApiToken(first.server.sessionId)
		await fetch(`${first.apiUrl}/v1/capability-proxy/call`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				path: ['kody', 'packageStorageSet'],
				args: [{ key: 'channelId', value: '123456789012345678' }],
			}),
		})
		await first.server.close()

		const second = await ensureMockTarget({
			sessionId: 'shared',
			packageId,
			env,
		})
		const token2 = mintMockApiToken(second.server.sessionId)
		const got = await fetch(`${second.apiUrl}/v1/capability-proxy/call`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token2}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				path: ['kody', 'packageStorageGet'],
				args: [{ key: 'channelId' }],
			}),
		})
		const body = (await got.json()) as { result: { value: string } }
		assert.equal(body.result.value, '123456789012345678')
		await second.server.close()
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('P2: metaGetCurrentUser is flat user_id; --org honored', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-org-'))
	try {
		await withMockServer(
			{
				sessionId: 'org',
				env: { KODY_CACHE_DIR: cache },
				resetStorage: true,
				orgSlug: 'acme',
			},
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const me = await fetch(`${server.url}/v1/me`, {
					headers: { authorization: `Bearer ${token}` },
				})
				const body = (await me.json()) as {
					user_id: string
					username: string
					display_name: string
					org: { slug: string }
				}
				assert.equal(body.user_id, 'user_mock')
				assert.equal(body.username, 'mock-user')
				assert.equal(body.display_name, 'Mock User')
				assert.equal(body.org.slug, 'acme')
				assert.equal('user' in body, false)

				const viaQuery = await fetch(`${server.url}/v1/capability-proxy/call?org=other`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ path: ['kody', 'metaGetCurrentUser'], args: [{}] }),
				})
				const qBody = (await viaQuery.json()) as { result: { org: { slug: string } } }
				assert.equal(qBody.result.org.slug, 'other')
			},
		)
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('P2: local deps resolve self-package without login', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-local-deps-'))
	try {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@local/demo',
				type: 'module',
				exports: {
					'.': './src/index.ts',
					'./helper': './src/helper.ts',
				},
				kody: { id: 'demo' },
			}),
		)
		await mkdir(join(root, 'src'), { recursive: true })
		await writeFile(join(root, 'src/helper.ts'), `export const value = 42\n`)
		await writeFile(
			join(root, 'src/index.ts'),
			`import { value } from 'kody:@local/demo/helper'\nexport default async () => value\n`,
		)
		const code = await (
			await import('../src/local-bundle.js')
		).bundleLocalUserModule(join(root, 'src/index.ts'))
		// Bundler may inline relative imports; ensure kody:@ form is what we resolve.
		const source = `import { value } from 'kody:@local/demo/helper'\nexport default async () => value\n`
		const manifest = await loadPackageManifest(root)
		const resolved = await resolveLocalPackageModules({
			code: source,
			packageRoot: root,
			selfManifest: manifest,
		})
		assert.equal(resolved.unresolved.length, 0)
		assert.ok(resolved.modules.some((m) => m.name === 'kody:@local/demo/helper'))
		assert.match(resolved.modules[0]?.esModule ?? '', /42/)
		void code
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('P2: .kody/deps.json maps unpublished sibling packages', async () => {
	const parent = await mkdtemp(join(tmpdir(), 'kody-deps-map-'))
	const app = join(parent, 'app')
	const lib = join(parent, 'lib')
	try {
		await mkdir(app, { recursive: true })
		await mkdir(join(lib, 'src'), { recursive: true })
		await writeFile(
			join(lib, 'package.json'),
			JSON.stringify({
				name: '@local/lib',
				type: 'module',
				exports: { '.': './src/index.ts', './util': './src/util.ts' },
				kody: { id: 'lib' },
			}),
		)
		await writeFile(join(lib, 'src/util.ts'), `export const ping = 'pong'\n`)
		await writeFile(join(lib, 'src/index.ts'), `export * from './util.ts'\n`)
		await writeFile(
			join(app, 'package.json'),
			JSON.stringify({
				name: '@local/app',
				type: 'module',
				exports: { '.': './main.ts' },
				kody: { id: 'app', localDeps: { '@local/lib': '../lib' } },
			}),
		)
		await writeFile(
			join(app, 'main.ts'),
			`import { ping } from 'kody:@local/lib/util'\nexport default async () => ping\n`,
		)
		const manifest = await loadPackageManifest(app)
		const resolved = await resolveLocalPackageModules({
			code: `import { ping } from 'kody:@local/lib/util'\nexport default async () => ping\n`,
			packageRoot: app,
			selfManifest: manifest,
		})
		assert.deepEqual(resolved.unresolved, [])
		assert.ok(resolved.modules[0]?.esModule.includes('pong'))
	} finally {
		await rm(parent, { recursive: true, force: true })
	}
})

test('P2: parseKodyPackageSpecifier handles scoped packages', () => {
	assert.deepEqual(parseKodyPackageSpecifier('kody:@kentcdodds/github/graphql'), {
		packageName: '@kentcdodds/github',
		exportKey: './graphql',
	})
	assert.deepEqual(parseKodyPackageSpecifier('kody:@kentcdodds/linkedin'), {
		packageName: '@kentcdodds/linkedin',
		exportKey: '.',
	})
})

test('P2: --invoke unknown export lists keys (exportsOnly)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-exports-'))
	try {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@local/x',
				exports: { '.': './a.ts', './greet': './b.ts' },
				kody: { id: 'x' },
			}),
		)
		await writeFile(join(root, 'a.ts'), 'export default 1\n')
		await writeFile(join(root, 'b.ts'), 'export default 2\n')
		const manifest = await loadPackageManifest(root)
		assert.throws(
			() => resolveExportModulePath(manifest, './profile', { exportsOnly: true }),
			(error: unknown) => {
				assert.ok(error instanceof StructuredCliError)
				assert.equal(error.code, 'dev_surface_missing')
				assert.match(error.message, /No package export/)
				assert.match(error.fix ?? '', /\.\/greet/)
				return true
			},
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('P3: private-network fetch gives a clear error', async () => {
	await assert.rejects(
		() =>
			dispatchMockGatewayFetch({
				handlers: [],
				passthroughHosts: [],
				allowPrivateNetwork: false,
				passthroughAll: true,
				request: { url: 'http://127.0.0.1:1/', method: 'GET' },
			}),
		(error: unknown) => {
			assert.ok(error instanceof StructuredCliError)
			assert.equal(error.code, 'unmocked_request')
			assert.match(error.message, /private\/local/)
			assert.match(error.fix ?? '', /--allow-private-network/)
			return true
		},
	)
})

test('P3: mocks.ts bundle_failed includes line number', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-mocks-syntax-'))
	try {
		await mkdir(join(root, '.kody'), { recursive: true })
		await writeFile(
			join(root, '.kody/mocks.ts'),
			`import { http } from 'msw'\nexport const handlers = [\n  http.get('https://x.test', () => {;;;\n`,
		)
		await assert.rejects(
			() => loadPackageMocks(root),
			(error: unknown) => {
				assert.ok(error instanceof StructuredCliError)
				assert.equal(error.code, 'bundle_failed')
				assert.match(error.where ?? '', /:\d+:/)
				return true
			},
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('P2: comments with kody:@ do not count as imports (already fixed)', () => {
	const code = `
// import x from 'kody:@scope/pkg/export'
/* import y from "kody:@scope/pkg/other" */
const docs = "from 'kody:@scope/pkg/docs'"
import real from 'kody:@scope/pkg/real'
`
	assert.deepEqual(listSavedPackageImports(code), ['kody:@scope/pkg/real'])
})
