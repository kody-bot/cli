/**
 * Loopback HTTP bridge between local workerd and the CLI host process.
 *
 * - `POST /call` — JSON CapabilityProxy hop (`{ path, args }` → `{ result|error }`)
 * - `POST /gateway-fetch` — streaming gateway-fetch hop (raw body in/out)
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { redact } from './redact.js'
import { runSecretHeader } from './local-runtime-source.js'

export const localBridgeCallPath = '/call'
export const localBridgeGatewayFetchPath = '/gateway-fetch'

export type LocalRuntimeBridge = {
	port: number
	close: () => Promise<void>
}

export type LocalRuntimeBridgeCall = {
	path: Array<string>
	args: Array<unknown>
}

export type LocalRuntimeBridgeInput = {
	runSecret: string
	forwardCall: (
		call: LocalRuntimeBridgeCall,
		signal: AbortSignal,
	) => Promise<unknown>
	/**
	 * Streaming gateway-fetch. Must write a complete HTTP response to
	 * `response` (status, headers, body) — including Open API error envelopes.
	 */
	forwardGatewayFetchStream: (input: {
		request: IncomingMessage
		response: ServerResponse
		signal: AbortSignal
	}) => Promise<void>
}

export async function startLocalRuntimeBridge(
	input: LocalRuntimeBridgeInput,
): Promise<LocalRuntimeBridge> {
	const inFlight = new AbortController()
	const server: Server = createServer(async (request, response) => {
		const replyJson = (status: number, body: unknown) => {
			response.writeHead(status, { 'content-type': 'application/json' })
			response.end(JSON.stringify(body))
		}
		if (request.headers[runSecretHeader] !== input.runSecret) {
			replyJson(403, { error: 'Forbidden' })
			return
		}
		if (request.method === 'POST' && request.url === localBridgeCallPath) {
			try {
				const call = parseBridgeCall(await readBodyText(request))
				const result = await input.forwardCall(call, inFlight.signal)
				replyJson(200, { result })
			} catch (error) {
				replyJson(200, {
					error: redact(error instanceof Error ? error.message : String(error)),
				})
			}
			return
		}
		if (request.method === 'POST' && request.url === localBridgeGatewayFetchPath) {
			try {
				await input.forwardGatewayFetchStream({
					request,
					response,
					signal: inFlight.signal,
				})
			} catch (error) {
				if (response.headersSent) {
					response.destroy(
						error instanceof Error ? error : new Error(String(error)),
					)
					return
				}
				replyJson(200, {
					error: redact(error instanceof Error ? error.message : String(error)),
				})
			}
			return
		}
		replyJson(403, { error: 'Forbidden' })
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})
	return {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise<void>((resolve) => {
				inFlight.abort()
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

export function parseBridgeCall(body: string): LocalRuntimeBridgeCall {
	const parsed = JSON.parse(body) as { path?: unknown; args?: unknown }
	if (
		!Array.isArray(parsed.path) ||
		parsed.path.length === 0 ||
		!parsed.path.every((segment) => typeof segment === 'string')
	) {
		throw new Error('Invalid kody:runtime call path.')
	}
	return {
		path: parsed.path as Array<string>,
		args: Array.isArray(parsed.args) ? parsed.args : [],
	}
}

export async function readBodyText(stream: IncomingMessage): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

export async function readBodyBuffer(stream: IncomingMessage): Promise<Buffer> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks)
}

/** Write a Web `Response` onto a Node `ServerResponse` (streams the body). */
export async function writeWebResponse(
	response: ServerResponse,
	web: Response,
): Promise<void> {
	const headers: Record<string, string | Array<string>> = {}
	web.headers.forEach((value, name) => {
		const existing = headers[name]
		if (existing === undefined) {
			headers[name] = value
			return
		}
		headers[name] = Array.isArray(existing)
			? [...existing, value]
			: [existing, value]
	})
	response.writeHead(web.status, web.statusText, headers)
	if (!web.body) {
		response.end()
		return
	}
	const nodeStream = Readable.fromWeb(
		web.body as import('node:stream/web').ReadableStream,
	)
	await new Promise<void>((resolve, reject) => {
		nodeStream.on('error', reject)
		response.on('error', reject)
		response.on('finish', () => resolve())
		nodeStream.pipe(response)
	})
}
