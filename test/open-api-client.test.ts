import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	OpenApiError,
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
