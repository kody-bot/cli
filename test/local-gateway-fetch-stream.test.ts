import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import {
	callCapabilityProxyGatewayFetchStream,
	gatewayFetchHeadersHeaderName,
	gatewayFetchMethodHeaderName,
	gatewayFetchUrlHeaderName,
} from '../src/capability-proxy.js'
import { forwardLocalGatewayFetchStream } from '../src/local-gateway-fetch-forward.js'
import {
	localBridgeGatewayFetchPath,
	startLocalRuntimeBridge,
	writeWebResponse,
} from '../src/local-runtime-bridge.js'
import { runSecretHeader } from '../src/local-runtime-source.js'
import { createMockFetchGateway } from '../src/mock/mock-fetch-gateway.js'

test('callCapabilityProxyGatewayFetchStream posts metadata headers and streams the body', async () => {
	const chunks: Array<Buffer> = []
	let requestHeaders: Record<string, string | Array<string> | undefined> = {}
	const server = createServer((request, response) => {
		requestHeaders = { ...request.headers }
		request.on('data', (chunk: Buffer) => chunks.push(chunk))
		request.on('end', () => {
			response.writeHead(201, {
				'content-type': 'text/plain',
				'x-upstream': '1',
			})
			response.end('upstream-ok')
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	try {
		const body = Readable.from([Buffer.from('hello-stream')])
		const response = await callCapabilityProxyGatewayFetchStream({
			apiUrl: `http://127.0.0.1:${port}`,
			token: 'kody_at_test',
			gateway: {
				url: 'https://example.com/upload',
				method: 'POST',
				packageId: 'pkg-1',
				headers: { authorization: 'Bearer {{secret:demo}}' },
				contentType: 'text/plain',
				secretResolution: 'on',
			},
			body,
			contentLength: String(Buffer.byteLength('hello-stream')),
		})
		assert.equal(response.status, 201)
		assert.equal(await response.text(), 'upstream-ok')
		assert.equal(requestHeaders[gatewayFetchUrlHeaderName.toLowerCase()], 'https://example.com/upload')
		assert.equal(requestHeaders[gatewayFetchMethodHeaderName.toLowerCase()], 'POST')
		assert.equal(requestHeaders['content-type'], 'text/plain')
		assert.equal(
			requestHeaders[gatewayFetchHeadersHeaderName.toLowerCase()],
			JSON.stringify({ authorization: 'Bearer {{secret:demo}}' }),
		)
		assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello-stream')
		assert.equal(requestHeaders.authorization, 'Bearer kody_at_test')
	} finally {
		server.close()
	}
})

test('local runtime bridge streams gateway-fetch to the mock MSW gateway', async () => {
	const { http, HttpResponse } = await import('msw')
	const gateway = createMockFetchGateway({
		handlers: [
			http.post('https://api.example.com/upload', async ({ request }) => {
				const text = await request.text()
				return HttpResponse.json({ ok: true, echo: text }, { status: 202 })
			}),
		],
	})
	const bridge = await startLocalRuntimeBridge({
		runSecret: 'secret',
		forwardCall: async () => {
			throw new Error('JSON /call should not be used for gatewayFetchStream')
		},
		forwardGatewayFetchStream: async ({ request, response, signal }) => {
			await forwardLocalGatewayFetchStream({
				request,
				response,
				signal,
				client: {
					apiUrl: 'http://127.0.0.1:9',
					token: 'kody_at_unused',
				},
				mockFetchGateway: gateway,
			})
		},
	})
	try {
		const response = await fetch(
			`http://127.0.0.1:${bridge.port}${localBridgeGatewayFetchPath}`,
			{
				method: 'POST',
				headers: {
					[runSecretHeader]: 'secret',
					[gatewayFetchUrlHeaderName]: 'https://api.example.com/upload',
					[gatewayFetchMethodHeaderName]: 'POST',
					'content-type': 'text/plain',
				},
				body: 'payload-bytes',
				duplex: 'half',
			} as RequestInit,
		)
		assert.equal(response.status, 202)
		assert.deepEqual(await response.json(), { ok: true, echo: 'payload-bytes' })
	} finally {
		await bridge.close()
	}
})

test('writeWebResponse pipes status, headers, and body', async () => {
	const server = createServer(async (_request, response) => {
		await writeWebResponse(
			response,
			new Response('piped', {
				status: 203,
				headers: { 'x-test': 'yes', 'content-type': 'text/plain' },
			}),
		)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`)
		assert.equal(response.status, 203)
		assert.equal(response.headers.get('x-test'), 'yes')
		assert.equal(await response.text(), 'piped')
	} finally {
		server.close()
	}
})
