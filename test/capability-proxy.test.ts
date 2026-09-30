import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	callCapabilityProxy,
	capabilityProxyUrl,
	openCapabilityProxySession,
} from '../src/capability-proxy.js'

const token = 'kody_tok_secret_value'

function respondWith(status: number, body: unknown) {
	const requests: Array<{ url: string; method: string; headers: Headers; body: string | null }> =
		[]
	const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		requests.push({
			url: String(input),
			method: init?.method ?? 'GET',
			headers: new Headers(init?.headers),
			body: typeof init?.body === 'string' ? init.body : null,
		})
		return new Response(JSON.stringify(body), { status })
	}) as typeof fetch
	return { fetchFn, requests }
}

test('capabilityProxyUrl keeps an API base path prefix', () => {
	assert.equal(
		capabilityProxyUrl('https://api.kody.codes', 'v1/capability-proxy/call').href,
		'https://api.kody.codes/v1/capability-proxy/call',
	)
	assert.equal(
		capabilityProxyUrl('http://localhost:8787/api/', 'v1/capability-proxy/session').href,
		'http://localhost:8787/api/v1/capability-proxy/session',
	)
})

test('openCapabilityProxySession sends the bearer token and reads scopes + TTL', async () => {
	const { fetchFn, requests } = respondWith(200, {
		scopes: ['capability-proxy'],
		expiresAt: '2026-10-01T00:10:00Z',
	})
	const session = await openCapabilityProxySession({
		apiUrl: 'https://api.kody.codes',
		token,
		fetchFn,
	})
	assert.deepEqual(session, {
		scopes: ['capability-proxy'],
		expiresAt: '2026-10-01T00:10:00Z',
	})
	assert.equal(requests[0]?.url, 'https://api.kody.codes/v1/capability-proxy/session')
	assert.equal(requests[0]?.method, 'GET')
	assert.equal(requests[0]?.headers.get('authorization'), `Bearer ${token}`)
})

test('openCapabilityProxySession explains a rejected token without echoing it', async () => {
	const { fetchFn } = respondWith(401, { error: { code: 'invalid_token', message: 'expired' } })
	await assert.rejects(
		() => openCapabilityProxySession({ apiUrl: 'https://api.kody.codes', token, fetchFn }),
		(error: Error) => {
			assert.match(error.message, /rejected the API token/)
			assert.match(error.message, /--token or KODY_API_TOKEN/)
			assert.equal(error.message.includes(token), false)
			return true
		},
	)
})

test('openCapabilityProxySession names the local-execute flag when it is off', async () => {
	const { fetchFn } = respondWith(403, {
		error: { code: 'feature_disabled', message: 'local-execute is off' },
	})
	await assert.rejects(
		() => openCapabilityProxySession({ apiUrl: 'https://api.kody.codes', token, fetchFn }),
		/not enabled for this Kody account \(feature flag `local-execute`\)/,
	)
})

test('openCapabilityProxySession reports a missing CapabilityProxy deployment', async () => {
	const { fetchFn } = respondWith(404, null)
	await assert.rejects(
		() => openCapabilityProxySession({ apiUrl: 'https://api.kody.codes', token, fetchFn }),
		/CapabilityProxy was not found at https:\/\/api\.kody\.codes\/v1\/capability-proxy\/session/,
	)
})

test('openCapabilityProxySession reports unreachable APIs', async () => {
	const fetchFn = (async () => {
		throw new TypeError('fetch failed')
	}) as typeof fetch
	await assert.rejects(
		() => openCapabilityProxySession({ apiUrl: 'https://api.kody.codes', token, fetchFn }),
		/Could not reach the Kody API at https:\/\/api\.kody\.codes \(fetch failed\)/,
	)
})

test('callCapabilityProxy posts the runtime path, args, and conversation id', async () => {
	const { fetchFn, requests } = respondWith(200, { result: { sent: true } })
	const result = await callCapabilityProxy({
		apiUrl: 'https://api.kody.codes',
		token,
		fetchFn,
		path: ['kody', 'mcp', 'home', 'lights_on'],
		args: [{ room: 'office' }],
		conversationId: 'conv-1',
	})
	assert.deepEqual(result, { sent: true })
	assert.equal(requests[0]?.method, 'POST')
	assert.equal(requests[0]?.url, 'https://api.kody.codes/v1/capability-proxy/call')
	assert.equal(requests[0]?.headers.get('authorization'), `Bearer ${token}`)
	assert.deepEqual(JSON.parse(requests[0]?.body ?? ''), {
		path: ['kody', 'mcp', 'home', 'lights_on'],
		args: [{ room: 'office' }],
		conversationId: 'conv-1',
	})
})

test('callCapabilityProxy surfaces capability errors from string or object bodies', async () => {
	for (const body of [{ error: 'Unknown capability' }, { error: { code: 'x', message: 'Unknown capability' } }]) {
		const { fetchFn } = respondWith(200, body)
		await assert.rejects(
			() =>
				callCapabilityProxy({
					apiUrl: 'https://api.kody.codes',
					token,
					fetchFn,
					path: ['kody', 'nope'],
					args: [],
				}),
			/Unknown capability/,
		)
	}
	const { fetchFn } = respondWith(422, { error: { code: 'invalid_args', message: 'to is required' } })
	await assert.rejects(
		() =>
			callCapabilityProxy({
				apiUrl: 'https://api.kody.codes',
				token,
				fetchFn,
				path: ['kody', 'emailSend'],
				args: [{}],
			}),
		/to is required/,
	)
})
