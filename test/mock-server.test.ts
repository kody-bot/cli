import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	ensureMockTarget,
	mintMockApiToken,
	startMockServer,
	withMockServer,
} from '../src/mock/mock-server.js'
import { mockCapabilityPaths, mockOpenApiOperationIds } from '../src/mock/mock-supported.js'

test('mock session + search + metaGetCurrentUser work', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	try {
		await withMockServer(
			{ sessionId: 't1', env: { KODY_CACHE_DIR: cache }, resetStorage: true },
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const me = await fetch(`${server.url}/v1/me`, {
					headers: { authorization: `Bearer ${token}` },
				})
				assert.equal(me.status, 200)
				const meBody = (await me.json()) as { user: { username: string } }
				assert.equal(meBody.user.username, 'mock-user')

				const search = await fetch(`${server.url}/v1/search?query=local`, {
					headers: { authorization: `Bearer ${token}` },
				})
				assert.equal(search.status, 200)
				const searchBody = (await search.json()) as { matches: Array<{ id: string }> }
				assert.ok(searchBody.matches.some((m) => m.id === 'local_execute'))
			},
		)
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('mock CapabilityProxy call for metaGetCurrentUser', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	try {
		const server = await startMockServer({
			sessionId: 'cap',
			env: { KODY_CACHE_DIR: cache },
			resetStorage: true,
		})
		try {
			const token = mintMockApiToken(server.sessionId)
			const response = await fetch(`${server.url}/v1/capability-proxy/call`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ path: ['kody', 'metaGetCurrentUser'], args: [{}] }),
			})
			assert.equal(response.status, 200)
			const body = (await response.json()) as { result: { org: { slug: string } } }
			assert.equal(body.result.org.slug, 'mock-org')
		} finally {
			await server.close()
		}
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('mock refuses unimplemented capability paths with not_implemented_in_mock', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	try {
		await withMockServer(
			{ sessionId: 'refuse', env: { KODY_CACHE_DIR: cache }, resetStorage: true },
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const response = await fetch(`${server.url}/v1/capability-proxy/call`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ path: ['kody', 'emailSend'], args: [{}] }),
				})
				assert.equal(response.status, 501)
				const body = (await response.json()) as {
					error: { code: string; target: string }
				}
				assert.equal(body.error.code, 'not_implemented_in_mock')
				assert.equal(body.error.target, 'mock')
			},
		)
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('mock package-graph returns empty modules', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	try {
		await withMockServer(
			{ sessionId: 'graph', env: { KODY_CACHE_DIR: cache }, resetStorage: true },
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const response = await fetch(`${server.url}/v1/local-execute/package-graph`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ code: 'export default async () => ({})' }),
				})
				assert.equal(response.status, 200)
				const body = (await response.json()) as { modules: Array<unknown> }
				assert.deepEqual(body.modules, [])
			},
		)
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('ensureMockTarget mints a bearer and can reset storage', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	const previous = process.env.KODY_CACHE_DIR
	process.env.KODY_CACHE_DIR = cache
	try {
		const first = await ensureMockTarget({ sessionId: 'ensure', resetStorage: true })
		first.server.state().packageStorage['p'] = { rows: { a: 1 } }
		await first.server.close()
		const second = await ensureMockTarget({ sessionId: 'ensure', resetStorage: true })
		assert.deepEqual(second.server.state().packageStorage, {})
		await second.server.close()
		assert.ok(second.token.startsWith('kody_mock_'))
	} finally {
		if (previous === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previous
		await rm(cache, { recursive: true, force: true })
	}
})

test('supported mock operation lists are non-empty contract anchors', () => {
	assert.ok(mockOpenApiOperationIds.includes('search'))
	assert.ok(mockCapabilityPaths.includes('kody.metaGetCurrentUser'))
	assert.ok(mockCapabilityPaths.includes('kody.search'))
})
