import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	assertTokenSafeApiUrl,
	callCapabilityProxy,
	capabilityProxyUrl,
	openCapabilityProxySession,
} from '../src/capability-proxy.js'

const token = 'kody_at_secret_value'

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

test('openCapabilityProxySession explains rejected login OAuth and names the platform gap', async () => {
	const oauth = 'oauth-access-from-login'
	const { fetchFn } = respondWith(401, {
		error: { code: 'unauthorized', message: 'Invalid API token.' },
	})
	await assert.rejects(
		() => openCapabilityProxySession({ apiUrl: 'https://api.kody.codes', token: oauth, fetchFn }),
		(error: Error) => {
			assert.match(error.message, /kody login/)
			assert.match(error.message, /kentcdodds\/kody\/issues\/2812/)
			assert.match(error.message, /kody_at_/)
			assert.equal(error.message.includes(oauth), false)
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
		/feature_disabled[\s\S]*feature flag `local-execute`/,
	)
})

test('openCapabilityProxySession names insufficient_scope and the required scope', async () => {
	const { fetchFn } = respondWith(403, {
		error: {
			code: 'insufficient_scope',
			message: 'need local-execute',
			details: { required_scope: 'local-execute' },
		},
	})
	await assert.rejects(
		() => openCapabilityProxySession({ apiUrl: 'https://api.kody.codes', token, fetchFn }),
		/insufficient_scope[\s\S]*local-execute[\s\S]*tokenCreate[\s\S]*KODY_API_TOKEN/,
	)
})

test('openCapabilityProxySession reports a missing CapabilityProxy deployment', async () => {
	const { fetchFn } = respondWith(404, null)
	await assert.rejects(
		() => openCapabilityProxySession({ apiUrl: 'https://api.kody.codes', token, fetchFn }),
		/CapabilityProxy was not found at https:\/\/api\.kody\.codes\/v1\/capability-proxy\/session/,
	)
})

test('openCapabilityProxySession reports unreachable APIs with the network cause', async () => {
	const fetchFn = (async () => {
		throw new TypeError('fetch failed', {
			cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
		})
	}) as typeof fetch
	await assert.rejects(
		() => openCapabilityProxySession({ apiUrl: 'https://api.kody.codes', token, fetchFn }),
		/Could not reach the Kody API at https:\/\/api\.kody\.codes \(fetch failed: ECONNREFUSED\)/,
	)
})

test('assertTokenSafeApiUrl allows https and loopback http only', () => {
	assert.doesNotThrow(() => assertTokenSafeApiUrl('https://api.kody.codes'))
	assert.doesNotThrow(() => assertTokenSafeApiUrl('http://localhost:8787'))
	assert.doesNotThrow(() => assertTokenSafeApiUrl('http://127.0.0.1:8787/api'))
	assert.doesNotThrow(() => assertTokenSafeApiUrl('http://[::1]:8787'))
	assert.throws(() => assertTokenSafeApiUrl('http://api.kody.codes'), /Refusing to send the API token/)
	assert.throws(() => assertTokenSafeApiUrl('not a url'), /Invalid Kody API URL/)
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
	const forbidden = respondWith(403, {
		error: { code: 'capability_denied', message: 'emailSend needs a verified destination' },
	})
	await assert.rejects(
		() =>
			callCapabilityProxy({
				apiUrl: 'https://api.kody.codes',
				token,
				fetchFn: forbidden.fetchFn,
				path: ['kody', 'emailSend'],
				args: [{}],
			}),
		(error: Error) => error.message === 'emailSend needs a verified destination',
	)
	const missingScope = respondWith(403, {
		error: {
			code: 'insufficient_scope',
			message: 'emailSend is not granted',
			details: { required_scopes: ['email:send'] },
		},
	})
	await assert.rejects(
		() =>
			callCapabilityProxy({
				apiUrl: 'https://api.kody.codes',
				token,
				fetchFn: missingScope.fetchFn,
				path: ['kody', 'emailSend'],
				args: [{}],
			}),
		/insufficient_scope[\s\S]*email:send[\s\S]*tokenCreate/,
	)
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
