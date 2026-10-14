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
	assert.ok(mockCapabilityPaths.includes('kody.credentialClientOpenAll'))
	assert.ok(mockCapabilityPaths.includes('kody.authenticatedFetch'))
	assert.ok(mockCapabilityPaths.includes('kody.adminUserList'))
})

test('mock credentialClientOpen returns hosts so credential() can iterate', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cred-'))
	try {
		await withMockServer(
			{ sessionId: 'cred', env: { KODY_CACHE_DIR: cache }, resetStorage: true },
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const response = await fetch(`${server.url}/v1/capability-proxy/call`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						path: ['kody', 'credentialClientOpen'],
						args: [{ key: 'MOCK_SECRET' }],
					}),
				})
				assert.equal(response.status, 200)
				const body = (await response.json()) as {
					result: {
						ok: boolean
						value: { hosts: Array<string>; name: string; kind: string }
					}
				}
				assert.equal(body.result.ok, true)
				assert.equal(body.result.value.name, 'MOCK_SECRET')
				assert.ok(Array.isArray(body.result.value.hosts))
				assert.ok(body.result.value.hosts.length > 0)
			},
		)
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('mock credentials OpenAll + authenticatedFetch + adminUserList fixtures', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-ops-'))
	try {
		await withMockServer(
			{ sessionId: 'ops', env: { KODY_CACHE_DIR: cache }, resetStorage: true },
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const call = async (path: Array<string>, args: Array<unknown> = [{}]) => {
					const response = await fetch(`${server.url}/v1/capability-proxy/call`, {
						method: 'POST',
						headers: {
							authorization: `Bearer ${token}`,
							'content-type': 'application/json',
						},
						body: JSON.stringify({ path, args }),
					})
					assert.equal(response.status, 200)
					return (await response.json()) as { result: unknown }
				}

				const openAll = (await call(['kody', 'credentialClientOpenAll'], [
					{ key: 'MOCK_SECRET' },
				])) as {
					result: { ok: boolean; value: Array<{ name: string; hosts: Array<string> }> }
				}
				assert.equal(openAll.result.ok, true)
				assert.equal(openAll.result.value.length, 1)
				assert.equal(openAll.result.value[0]?.name, 'MOCK_SECRET')

				const oauth = (await call(['kody', 'authenticatedFetch'], [
					{
						providerName: 'linkedin',
						request: { url: 'https://api.linkedin.com/v2/userinfo', method: 'GET' },
					},
				])) as {
					result: { status: number; bodyBase64: string }
				}
				assert.equal(oauth.result.status, 200)
				const decoded = JSON.parse(
					Buffer.from(oauth.result.bodyBase64, 'base64').toString('utf8'),
				) as { mock: boolean; providerName: string; sub: string }
				assert.equal(decoded.mock, true)
				assert.equal(decoded.providerName, 'linkedin')
				assert.equal(decoded.sub, 'mock-linkedin-sub')

				const storage = (await call(['kody', 'packageStorageSet'], [
					{ key: 'k', value: 1 },
				])) as { result: { ok: boolean } }
				assert.equal(storage.result.ok, true)
				const got = (await call(['kody', 'packageStorageGet'], [{ key: 'k' }])) as {
					result: { value: number }
				}
				assert.equal(got.result.value, 1)

				const create = (await call(['kody', 'packageStorageSql'], [
					{
						query:
							'CREATE TABLE IF NOT EXISTS sightings (file_id TEXT PRIMARY KEY, name TEXT NOT NULL)',
					},
				])) as { result: { rows: Array<unknown> } }
				assert.deepEqual(create.result.rows, [])
				await call(['kody', '__mockPackageStorageSql'], [
					{
						query: 'INSERT INTO sightings (file_id, name) VALUES (?, ?)',
						bindings: ['f1', 'a.txt'],
					},
				])
				const selected = (await call(['kody', 'packageStorageSql'], [
					{ query: 'SELECT file_id, name FROM sightings ORDER BY file_id' },
				])) as { result: { rows: Array<{ file_id: string; name: string }> } }
				assert.deepEqual(selected.result.rows, [{ file_id: 'f1', name: 'a.txt' }])

				const admin = (await call(['kody', 'adminUserList'], [{ page: 1 }])) as {
					result: { users: Array<{ username: string }>; mock: boolean }
				}
				assert.equal(admin.result.mock, true)
				assert.equal(admin.result.users[0]?.username, 'mock-user')
			},
		)
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})
