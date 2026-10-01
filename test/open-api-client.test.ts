import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	OpenApiError,
	assertApiOperationAllowed,
	buildOpenApiHttpRequest,
	callOpenApiOperation,
	clearOpenApiRouteCache,
	cliCredentialBootstrapRedeemOperationId,
	indexOpenApiOperations,
	searchWithApiToken,
	whoamiWithApiToken,
} from '../src/open-api-client.js'

test('searchWithApiToken calls GET /v1/search with the bearer token', async () => {
	const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new URL(String(input))
		assert.equal(url.pathname, '/v1/search')
		assert.equal(url.searchParams.get('query'), 'email')
		assert.equal(url.searchParams.get('domain'), 'email')
		assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, 'Bearer tok')
		return new Response(JSON.stringify({ matches: [{ id: 'emailSend' }], conversationId: 'c1' }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}) as typeof fetch

	const result = await searchWithApiToken({
		token: 'tok',
		apiUrl: 'https://api.kody.codes',
		query: 'email',
		domain: 'email',
		fetchFn,
	})
	assert.equal(result.isError, false)
	assert.match(result.content[0]?.text ?? '', /emailSend/)
})

test('searchWithApiToken rejects --entity with a clear message', async () => {
	await assert.rejects(
		() =>
			searchWithApiToken({
				token: 'tok',
				entity: 'capability:emailSend',
			}),
		/does not support --entity/,
	)
})

test('searchWithApiToken maps insufficient_scope to a mint-token hint', async () => {
	const fetchFn = (async () =>
		new Response(
			JSON.stringify({
				error: {
					code: 'insufficient_scope',
					message: 'missing search:read',
					details: { required_scope: 'search:read' },
				},
			}),
			{ status: 403, headers: { 'content-type': 'application/json' } },
		)) as typeof fetch
	await assert.rejects(
		() => searchWithApiToken({ token: 'tok', apiUrl: 'https://api.kody.codes', query: 'x', fetchFn }),
		(error: unknown) => {
			assert.ok(error instanceof OpenApiError)
			assert.equal(error.status, 403)
			assert.equal(error.code, 'insufficient_scope')
			assert.match(error.message, /insufficient_scope/)
			assert.match(error.message, /search:read/)
			assert.match(error.message, /tokenCreate/)
			return true
		},
	)
})

test('whoamiWithApiToken uses tokens/current and optional /me', async () => {
	const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
		const url = new URL(String(input))
		if (url.pathname === '/v1/tokens/current') {
			return new Response(
				JSON.stringify({
					id: 'tok_1',
					name: 'cli',
					scopes: ['search:read', 'local-execute'],
					expires_at: '2026-10-01T12:00:00.000Z',
					max_expires_at: '2026-10-02T00:00:00.000Z',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		if (url.pathname === '/v1/me') {
			return new Response(
				JSON.stringify({
					user_id: 'u1',
					email: 'me@example.com',
					display_name: 'Me',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		return new Response('nope', { status: 404 })
	}) as typeof fetch

	const identity = await whoamiWithApiToken({
		token: 'tok',
		apiUrl: 'https://api.kody.codes',
		fetchFn,
	})
	assert.equal(identity.token.id, 'tok_1')
	assert.deepEqual(identity.token.scopes, ['search:read', 'local-execute'])
	assert.equal(identity.user?.email, 'me@example.com')
})

test('whoamiWithApiToken tolerates missing account:read on /me', async () => {
	const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
		const url = new URL(String(input))
		if (url.pathname === '/v1/tokens/current') {
			return new Response(
				JSON.stringify({ id: 'tok_1', name: 'cli', scopes: ['local-execute'] }),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		return new Response(
			JSON.stringify({
				error: {
					code: 'insufficient_scope',
					message: 'need account:read',
					details: { required_scope: 'account:read' },
				},
			}),
			{ status: 403, headers: { 'content-type': 'application/json' } },
		)
	}) as typeof fetch

	const identity = await whoamiWithApiToken({
		token: 'tok',
		apiUrl: 'https://api.kody.codes',
		fetchFn,
	})
	assert.equal(identity.user, null)
	assert.equal(identity.token.id, 'tok_1')
})

test('indexOpenApiOperations maps operationId to method and path params', () => {
	const ops = indexOpenApiOperations({
		paths: {
			'/v1/account/usage': {
				get: { operationId: 'usageGet' },
			},
			'/v1/secrets/{scope}/{name}': {
				put: { operationId: 'secretSet' },
			},
			'/v1/search': {
				get: { operationId: 'search' },
			},
		},
	})
	assert.deepEqual(ops.get('usageGet'), {
		operationId: 'usageGet',
		method: 'GET',
		pathTemplate: '/v1/account/usage',
		pathParamNames: [],
	})
	assert.deepEqual(ops.get('secretSet'), {
		operationId: 'secretSet',
		method: 'PUT',
		pathTemplate: '/v1/secrets/{scope}/{name}',
		pathParamNames: ['scope', 'name'],
	})
})

test('buildOpenApiHttpRequest splits path / query / body like MCP api params', () => {
	assert.deepEqual(
		buildOpenApiHttpRequest({
			route: {
				operationId: 'usageGet',
				method: 'GET',
				pathTemplate: '/v1/account/usage',
				pathParamNames: [],
			},
			params: {},
		}),
		{ method: 'GET', path: '/v1/account/usage' },
	)
	assert.deepEqual(
		buildOpenApiHttpRequest({
			route: {
				operationId: 'search',
				method: 'GET',
				pathTemplate: '/v1/search',
				pathParamNames: [],
			},
			params: { query: 'email', limit: 5 },
		}),
		{ method: 'GET', path: '/v1/search', query: { query: 'email', limit: 5 } },
	)
	assert.deepEqual(
		buildOpenApiHttpRequest({
			route: {
				operationId: 'secretSet',
				method: 'PUT',
				pathTemplate: '/v1/secrets/{scope}/{name}',
				pathParamNames: ['scope', 'name'],
			},
			params: { scope: 'user', name: 'api-key', value: 'secret' },
		}),
		{
			method: 'PUT',
			path: '/v1/secrets/user/api-key',
			body: { value: 'secret' },
		},
	)
	assert.throws(
		() =>
			buildOpenApiHttpRequest({
				route: {
					operationId: 'secretSet',
					method: 'PUT',
					pathTemplate: '/v1/secrets/{scope}/{name}',
					pathParamNames: ['scope', 'name'],
				},
				params: { name: 'only-name' },
			}),
		/Missing required path parameter "scope"/,
	)
})

test('assertApiOperationAllowed refuses bootstrap redeem', () => {
	assert.throws(
		() => assertApiOperationAllowed(cliCredentialBootstrapRedeemOperationId),
		/auth bootstrap --code/,
	)
})

test('callOpenApiOperation loads openapi.json then calls the route', async () => {
	clearOpenApiRouteCache()
	const calls: Array<string> = []
	const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new URL(String(input))
		calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}${url.search}`)
		if (url.pathname === '/openapi.json') {
			return new Response(
				JSON.stringify({
					paths: {
						'/v1/account/usage': { get: { operationId: 'usageGet' } },
						'/v1/tokens': { post: { operationId: 'tokenCreate' } },
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		if (url.pathname === '/v1/account/usage') {
			assert.equal(
				init?.headers && (init.headers as Record<string, string>).authorization,
				'Bearer tok',
			)
			return new Response(JSON.stringify({ plan: 'pro', resources: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}
		return new Response('nope', { status: 404 })
	}) as typeof fetch

	const result = await callOpenApiOperation({
		token: 'tok',
		apiUrl: 'https://api.kody.codes',
		operationId: 'usageGet',
		params: {},
		fetchFn,
	})
	assert.deepEqual(result, { plan: 'pro', resources: [] })
	assert.deepEqual(calls, ['GET /openapi.json', 'GET /v1/account/usage'])
})

test('callOpenApiOperation errors on unknown operationId', async () => {
	await assert.rejects(
		() =>
			callOpenApiOperation({
				token: 'tok',
				apiUrl: 'https://api.kody.codes',
				operationId: 'notARealOp',
				operations: new Map([
					[
						'usageGet',
						{
							operationId: 'usageGet',
							method: 'GET',
							pathTemplate: '/v1/account/usage',
							pathParamNames: [],
						},
					],
				]),
			}),
		/Unknown operationId "notARealOp"/,
	)
})

test('callOpenApiOperation refuses cliCredentialBootstrapRedeem', async () => {
	await assert.rejects(
		() =>
			callOpenApiOperation({
				token: 'tok',
				operationId: cliCredentialBootstrapRedeemOperationId,
				params: { code: 'kody_bc_x' },
				operations: new Map(),
			}),
		/auth bootstrap --code/,
	)
})

test('callOpenApiOperation POSTs body params for write ops', async () => {
	const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new URL(String(input))
		assert.equal(url.pathname, '/v1/tokens')
		assert.equal(init?.method, 'POST')
		assert.equal(init?.body, JSON.stringify({ name: 'cli', scopes: ['search:read'] }))
		return new Response(JSON.stringify({ id: 'tok_1', name: 'cli' }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}) as typeof fetch

	const result = await callOpenApiOperation({
		token: 'tok',
		apiUrl: 'https://api.kody.codes',
		operationId: 'tokenCreate',
		params: { name: 'cli', scopes: ['search:read'] },
		operations: new Map([
			[
				'tokenCreate',
				{
					operationId: 'tokenCreate',
					method: 'POST',
					pathTemplate: '/v1/tokens',
					pathParamNames: [],
				},
			],
		]),
		fetchFn,
	})
	assert.deepEqual(result, { id: 'tok_1', name: 'cli' })
})
