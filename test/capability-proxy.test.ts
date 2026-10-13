import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Agent, EnvHttpProxyAgent } from 'undici'
import {
	assertTokenSafeApiUrl,
	callCapabilityProxy,
	capabilityProxyGatewayDeadlineMs,
	capabilityProxyHttpTimeoutMs,
	capabilityProxyUrl,
	checkCredentialCallMap,
	createCapabilityProxyAgent,
	nodeUsesEnvProxy,
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
		features: ['credential-call-map'],
	})
	const session = await openCapabilityProxySession({
		apiUrl: 'https://api.kody.codes',
		token,
		fetchFn,
	})
	assert.deepEqual(session, {
		scopes: ['capability-proxy'],
		expiresAt: '2026-10-01T00:10:00Z',
		features: ['credential-call-map'],
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
		/insufficient_scope[\s\S]*local-execute[\s\S]*cliCredentialBootstrap[\s\S]*tokenCreate[\s\S]*KODY_API_TOKEN/,
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

test('callCapabilityProxy sends credentials as a top-level field outside args', async () => {
	const { fetchFn, requests } = respondWith(200, { result: { ok: true } })
	await callCapabilityProxy({
		apiUrl: 'https://api.kody.codes',
		token,
		fetchFn,
		path: ['kody', 'credentialClientOpen'],
		args: [{ key: 'github' }],
		credentials: { github: 'work' },
	})
	assert.deepEqual(JSON.parse(requests[0]?.body ?? ''), {
		path: ['kody', 'credentialClientOpen'],
		args: [{ key: 'github' }],
		credentials: { github: 'work' },
	})
})

test('checkCredentialCallMap preflights picks and surfaces structured failures', async () => {
	const ok = respondWith(200, { result: { ok: true, value: { warnings: ['unknown key'] } } })
	assert.deepEqual(
		await checkCredentialCallMap({
			apiUrl: 'https://api.kody.codes',
			token,
			fetchFn: ok.fetchFn,
			credentials: { github: 'work' },
		}),
		{ warnings: ['unknown key'] },
	)
	assert.deepEqual(JSON.parse(ok.requests[0]?.body ?? ''), {
		path: ['kody', 'credentialClientCheck'],
		args: [{}],
		credentials: { github: 'work' },
	})

	const fail = respondWith(200, {
		result: { ok: false, error: { code: 'credential_not_found', message: 'No match.' } },
	})
	await assert.rejects(
		() =>
			checkCredentialCallMap({
				apiUrl: 'https://api.kody.codes',
				token,
				fetchFn: fail.fetchFn,
				credentials: { github: 'missing' },
			}),
		(error: Error & { code?: string | null }) => {
			assert.match(error.message, /^credential_not_found: No match\./)
			assert.equal(error.code, 'credential_not_found')
			return true
		},
	)

	const withRetry = respondWith(200, {
		result: {
			ok: false,
			error: {
				code: 'credential_ambiguous',
				message: 'Several match.',
				retryWith: [{ credentials: { github: { name: 'work', scope: 'org' } } }],
			},
		},
	})
	await assert.rejects(
		() =>
			checkCredentialCallMap({
				apiUrl: 'https://api.kody.codes',
				token,
				fetchFn: withRetry.fetchFn,
				credentials: { github: 'a' },
			}),
		/credential_ambiguous: Several match\.[\s\S]*retry: --credential github=org:work/,
	)
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
		/insufficient_scope[\s\S]*email:send[\s\S]*cliCredentialBootstrap[\s\S]*tokenCreate/,
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

async function withDelayedHeadersServer(
	delayMs: number,
	run: (apiUrl: string, seen: Array<{ url: string; authorization: string | null }>) => Promise<void>,
) {
	const seen: Array<{ url: string; authorization: string | null }> = []
	const server = createServer((request, response) => {
		seen.push({ url: request.url ?? '', authorization: request.headers.authorization ?? null })
		request.resume()
		setTimeout(() => {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.end(JSON.stringify({ result: { ok: true } }))
		}, delayMs)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	try {
		await run(`http://127.0.0.1:${port}`, seen)
	} finally {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
}

test('CapabilityProxy HTTP timeouts outlast the 5-minute gateway deadline plus overhead', () => {
	assert.equal(capabilityProxyGatewayDeadlineMs, 5 * 60_000)
	// Node's global fetch defaults headersTimeout to 300s, the same as the deadline.
	assert.ok(capabilityProxyHttpTimeoutMs >= capabilityProxyGatewayDeadlineMs + 60_000)
})

test('the CapabilityProxy dispatcher governs how long a call waits for headers', async () => {
	await withDelayedHeadersServer(2_500, async (apiUrl) => {
		const call = async (timeoutMs: number) =>
			callCapabilityProxy({
				apiUrl,
				token,
				dispatcher: await createCapabilityProxyAgent(timeoutMs),
				path: ['kody', 'emailSend'],
				args: [{}],
			})
		await assert.rejects(() => call(1_000), /Could not reach the Kody API[\s\S]*UND_ERR_HEADERS_TIMEOUT/)
		assert.deepEqual(await call(10_000), { ok: true })
	})
})

test('callCapabilityProxy passes the shared long-timeout Agent to fetch by default', async () => {
	const dispatchers: Array<unknown> = []
	const fetchFn = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		dispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher)
		return new Response(JSON.stringify({ result: 1 }), { status: 200 })
	}) as typeof fetch
	const client = { apiUrl: 'https://api.kody.codes', token, fetchFn }
	await openCapabilityProxySession(client)
	await callCapabilityProxy({ ...client, path: ['kody', 'emailSend'], args: [{}] })
	assert.equal(dispatchers.length, 2)
	assert.ok(dispatchers[0] instanceof Agent)
	assert.equal(dispatchers[0], dispatchers[1])
})

test('callCapabilityProxy reaches a real server through global fetch and the default Agent', async () => {
	await withDelayedHeadersServer(0, async (apiUrl, seen) => {
		const result = await callCapabilityProxy({
			apiUrl,
			token,
			path: ['kody', 'emailSend'],
			args: [{}],
		})
		assert.deepEqual(result, { ok: true })
		assert.equal(seen[0]?.url, '/v1/capability-proxy/call')
		assert.equal(seen[0]?.authorization, `Bearer ${token}`)
	})
})

test('nodeUsesEnvProxy mirrors Node\'s NODE_USE_ENV_PROXY / --use-env-proxy opt-in', async () => {
	assert.equal(nodeUsesEnvProxy({}, []), false)
	assert.equal(nodeUsesEnvProxy({ HTTPS_PROXY: 'http://proxy.test:8080' }, []), false)
	assert.equal(nodeUsesEnvProxy({ NODE_USE_ENV_PROXY: '1' }, []), true)
	assert.equal(nodeUsesEnvProxy({}, ['--use-env-proxy']), true)
	assert.equal(nodeUsesEnvProxy({ NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' }, []), true)
	assert.ok((await createCapabilityProxyAgent(1_000, { useEnvProxy: true })) instanceof EnvHttpProxyAgent)
	assert.ok((await createCapabilityProxyAgent(1_000, { useEnvProxy: false })) instanceof Agent)
})

test('with env proxy enabled, CapabilityProxy calls go through HTTP_PROXY', async () => {
	await withDelayedHeadersServer(0, async (apiUrl, seen) => {
		const proxied: Array<string> = []
		const proxy = createServer((request, response) => {
			proxied.push(`${request.method} ${request.url}`)
			response.writeHead(502).end()
		})
		proxy.on('connect', (request, clientSocket, head) => {
			proxied.push(`CONNECT ${request.url}`)
			const [host, port] = (request.url ?? '').split(':')
			const upstream = connect(Number(port), host, () => {
				clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
				upstream.write(head)
				upstream.pipe(clientSocket)
				clientSocket.pipe(upstream)
			})
			upstream.on('error', () => clientSocket.destroy())
			clientSocket.on('error', () => upstream.destroy())
		})
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
		const { port } = proxy.address() as AddressInfo
		const previous = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY }
		process.env.HTTP_PROXY = `http://127.0.0.1:${port}`
		delete process.env.NO_PROXY
		const dispatcher = await createCapabilityProxyAgent(5_000, { useEnvProxy: true })
		try {
			const result = await callCapabilityProxy({
				apiUrl,
				token,
				dispatcher,
				path: ['kody', 'emailSend'],
				args: [{}],
			})
			assert.deepEqual(result, { ok: true })
			assert.equal(proxied.length, 1)
			assert.match(proxied[0] ?? '', new RegExp(`^(CONNECT ${new URL(apiUrl).host}|POST ${apiUrl}/v1/capability-proxy/call)$`))
			assert.equal(seen[0]?.url, '/v1/capability-proxy/call')
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key]
				else process.env[key] = value
			}
			await dispatcher.destroy()
			proxy.closeAllConnections()
			await new Promise<void>((resolve) => proxy.close(() => resolve()))
		}
	})
})
