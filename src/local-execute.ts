import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { callCapabilityProxy, openCapabilityProxySession } from './capability-proxy.js'
import { apiTokenEnvVar } from './defaults.js'
import {
	createLocalEntrySource,
	createLocalRuntimeModuleSource,
	createWorkerdConfig,
	runSecretEnvVar,
	runSecretHeader,
} from './local-runtime-source.js'
import type { ToolCallResult } from './mcp.js'
import { redact } from './redact.js'
import { ensureWorkerdBinary } from './workerd-binary.js'

export type LocalExecuteInput = {
	code: string
	params?: unknown
	conversationId?: string
	token: string
	apiUrl: string
	/** Used for CapabilityProxy requests (session + proxied calls). */
	fetchFn?: typeof fetch
	/** Skip the pinned download and run this workerd binary. */
	workerdPath?: string
	onStatus?: (message: string) => void
}

type SandboxResponse = { result?: unknown; error?: string; logs?: Array<string> }

const workerdStartTimeoutMs = 30_000

export function assertNoStaticPackageImports(code: string): void {
	if (/(?:\bfrom\s*|\bimport\s*\(?\s*)["']kody:@/.test(code)) {
		throw new Error(
			'execute --local does not resolve saved-package imports (kody:@…) yet. Call the export with packages.invoke(specifier, options) from kody:runtime, or run execute without --local.',
		)
	}
}

export async function runLocalExecute(input: LocalExecuteInput): Promise<ToolCallResult> {
	assertNoStaticPackageImports(input.code)
	const client = { apiUrl: input.apiUrl, token: input.token, fetchFn: input.fetchFn }
	await openCapabilityProxySession(client)
	const workerdPath =
		input.workerdPath ??
		(await ensureWorkerdBinary({
			onDownload: (url) => input.onStatus?.(`Downloading workerd for local execute from ${url}…`),
		}))

	const runSecret = randomBytes(32).toString('hex')
	const bridge = await startBridge({
		runSecret,
		forward: (call) =>
			callCapabilityProxy({ ...client, ...call, conversationId: input.conversationId }),
	})
	const workDir = await mkdtemp(join(tmpdir(), 'kody-local-'))
	let child: ChildProcess | undefined
	const startedAt = new Date()
	try {
		const files = { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' }
		await writeFile(join(workDir, files.entry), createLocalEntrySource())
		await writeFile(join(workDir, files.user), input.code)
		await writeFile(join(workDir, files.runtime), createLocalRuntimeModuleSource())
		const configPath = join(workDir, 'config.capnp')
		await writeFile(configPath, createWorkerdConfig({ bridgePort: bridge.port, files }))

		const env: NodeJS.ProcessEnv = { ...process.env, [runSecretEnvVar]: runSecret }
		delete env[apiTokenEnvVar]
		child = spawn(workerdPath, ['serve', configPath, '--control-fd=3'], {
			cwd: workDir,
			env,
			stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
		})
		const workerd = watchWorkerd(child)
		const port = await workerd.listening
		const response = await Promise.race([
			fetch(`http://127.0.0.1:${port}/`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [runSecretHeader]: runSecret },
				body: JSON.stringify({ params: input.params ?? {} }),
			}),
			workerd.exited.then((detail) => ({ exitDetail: detail })),
		])
		if (!(response instanceof Response)) {
			throw new Error(`workerd exited during the run${response.exitDetail}`)
		}
		if (!response.ok) {
			throw new Error(`Local execute runtime returned HTTP ${response.status}.${workerd.stderr()}`)
		}
		const sandbox = (await response.json()) as SandboxResponse
		return buildLocalExecuteResult({
			sandbox,
			startedAt,
			endedAt: new Date(),
			conversationId: input.conversationId,
		})
	} finally {
		child?.kill()
		await bridge.close()
		await rm(workDir, { recursive: true, force: true })
	}
}

/** Same envelope as cloud execute so `formatToolResult` and `--json` behave identically. */
export function buildLocalExecuteResult(input: {
	sandbox: SandboxResponse
	startedAt: Date
	endedAt: Date
	conversationId?: string
}): ToolCallResult {
	const { sandbox } = input
	const logs = sandbox.logs ?? []
	const base = {
		...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
		timing: {
			startedAt: input.startedAt.toISOString(),
			endedAt: input.endedAt.toISOString(),
			durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
		},
	}
	if (typeof sandbox.error === 'string') {
		return {
			content: [{ type: 'text', text: `Error: ${sandbox.error}` }],
			structuredContent: {
				...base,
				returnedBytes: 0,
				error: sandbox.error,
				result: null,
				logs,
			},
			isError: true,
		}
	}
	const text =
		typeof sandbox.result === 'string'
			? sandbox.result
			: (JSON.stringify(sandbox.result, null, 2) ?? 'undefined')
	return {
		content: [{ type: 'text', text }],
		structuredContent: {
			...base,
			returnedBytes: Buffer.byteLength(JSON.stringify(sandbox.result) ?? ''),
			result: sandbox.result,
			logs,
		},
		isError: false,
	}
}

function watchWorkerd(child: ChildProcess) {
	let stderrText = ''
	child.stderr?.on('data', (chunk: Buffer) => {
		stderrText += chunk.toString('utf8')
	})
	child.stdout?.resume()
	const stderr = () => {
		const trimmed = redact(stderrText.trim())
		return trimmed ? `\n${trimmed}` : ''
	}
	const exited = new Promise<string>((resolve) => {
		child.once('exit', (code, signal) => {
			resolve(` (workerd exit ${signal ?? code})${stderr()}`)
		})
	})
	const listening = new Promise<number>((resolve, reject) => {
		const control = child.stdio[3] as Readable | null
		let buffered = ''
		const timer = setTimeout(() => {
			reject(new Error(`workerd did not start within ${workerdStartTimeoutMs / 1000}s.${stderr()}`))
		}, workerdStartTimeoutMs)
		control?.on('data', (chunk: Buffer) => {
			buffered += chunk.toString('utf8')
			for (const line of buffered.split('\n')) {
				const port = parseListenPort(line)
				if (port !== null) {
					clearTimeout(timer)
					resolve(port)
				}
			}
		})
		child.once('error', (error) => {
			clearTimeout(timer)
			reject(new Error(`Could not start workerd: ${error.message}`))
		})
		void exited.then((detail) => {
			clearTimeout(timer)
			reject(new Error(`Local execute could not load the module${detail}`))
		})
	})
	return { listening, exited, stderr }
}

function parseListenPort(line: string): number | null {
	if (!line.trim()) return null
	try {
		const event = JSON.parse(line) as { event?: string; socket?: string; port?: number }
		return event.event === 'listen' && event.socket === 'http' && typeof event.port === 'number'
			? event.port
			: null
	} catch {
		return null
	}
}

async function startBridge(input: {
	runSecret: string
	forward: (call: { path: Array<string>; args: Array<unknown> }) => Promise<unknown>
}): Promise<{ port: number; close: () => Promise<void> }> {
	const server: Server = createServer(async (request, response) => {
		const reply = (status: number, body: unknown) => {
			response.writeHead(status, { 'content-type': 'application/json' })
			response.end(JSON.stringify(body))
		}
		if (
			request.method !== 'POST' ||
			request.url !== '/call' ||
			request.headers[runSecretHeader] !== input.runSecret
		) {
			reply(403, { error: 'Forbidden' })
			return
		}
		try {
			const call = parseBridgeCall(await readBody(request))
			const result = await input.forward(call)
			reply(200, { result })
		} catch (error) {
			reply(200, { error: redact(error instanceof Error ? error.message : String(error)) })
		}
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})
	return {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

function parseBridgeCall(body: string): { path: Array<string>; args: Array<unknown> } {
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

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}
