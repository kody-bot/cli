import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import {
	assertTokenSafeApiUrl,
	callCapabilityProxy,
	openCapabilityProxySession,
} from './capability-proxy.js'
import { assertLocalExecuteNodeEngine } from './node-engine.js'
import { apiTokenEnvVar } from './defaults.js'
import {
	fetchLocalPackageGraph,
	hasSavedPackageImports,
	localExecuteGatewayFetchShimModuleName,
	type LocalPackageGraph,
} from './local-package-graph.js'
import {
	createLocalEntrySource,
	createLocalRuntimeModuleSource,
	createWorkerdConfig,
	runSecretEnvVar,
	runSecretHeader,
	type WorkerdPackageModuleFile,
} from './local-runtime-source.js'
import type { ToolCallResult } from './mcp.js'
import { redact } from './redact.js'
import { ensureWorkerdBinary } from './workerd-binary.js'

export {
	hasSavedPackageImports,
	listSavedPackageImports,
	localPackageGraphPlatformIssueUrl,
} from './local-package-graph.js'

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
	allowPrivateNetwork?: boolean
	onStatus?: (message: string) => void
}

type SandboxResponse = { result?: unknown; error?: string; logs?: Array<string> }

type Bridge = { port: number; close: () => Promise<void> }

const workerdStartTimeoutMs = 30_000
const workerdExitGraceMs = 1_000

export const savedPackageImportLocalResolveStatus =
	'Module imports saved packages (kody:@…). Fetching stamped package modules for local workerd bundling (no cloud kody.execute defer).'

export const localExecutePackageGraphResolveStatus =
	'Fetching local-execute package graph (gateway-fetch shim + any stamped kody:@ modules).'

export async function runLocalExecute(input: LocalExecuteInput): Promise<ToolCallResult> {
	assertLocalExecuteNodeEngine()
	assertTokenSafeApiUrl(input.apiUrl)
	const client = { apiUrl: input.apiUrl, token: input.token, fetchFn: input.fetchFn }
	await openCapabilityProxySession(client)

	// Always fetch package-graph: origin returns the gateway-fetch shim even
	// when there are no `kody:@` imports so ambient `{{secret:…}}` fetch hops
	// (or fails closed) instead of sending a raw placeholder (kody#3020).
	input.onStatus?.(
		hasSavedPackageImports(input.code)
			? savedPackageImportLocalResolveStatus
			: localExecutePackageGraphResolveStatus,
	)
	const packageGraph = await fetchLocalPackageGraph({
		...client,
		code: input.code,
		conversationId: input.conversationId,
	})

	const workerdPath =
		input.workerdPath ??
		(await ensureWorkerdBinary({
			onDownload: (url) => input.onStatus?.(`Downloading workerd for local execute from ${url}…`),
		}))

	const runSecret = randomBytes(32).toString('hex')
	const workDir = await mkdtemp(join(tmpdir(), 'kody-local-'))
	let child: ChildProcess | undefined
	let bridge: Bridge | undefined
	// SIGTERM makes workerd drain in-flight requests, which a hung module never finishes.
	const stopWorkerd = () => child?.kill('SIGKILL')
	const releaseSignals = cleanupOnSignal(() => {
		stopWorkerd()
		rmSync(workDir, { recursive: true, force: true })
	})
	const startedAt = new Date()
	const finish = (sandbox: SandboxResponse) =>
		buildLocalExecuteResult({
			sandbox,
			startedAt,
			endedAt: new Date(),
			conversationId: input.conversationId,
		})
	try {
		bridge = await startBridge({
			runSecret,
			forward: (call, signal) =>
				callCapabilityProxy({
					...client,
					...call,
					conversationId: input.conversationId,
					signal,
				}),
		})
		const files = { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' }
		const gatewayFetchShimModules = packageGraph.modules
			.map((module) => module.name)
			.filter((name) => name === localExecuteGatewayFetchShimModuleName)
		await writeFile(
			join(workDir, files.entry),
			createLocalEntrySource({ sideEffectModules: gatewayFetchShimModules }),
		)
		await writeFile(join(workDir, files.user), input.code)
		await writeFile(join(workDir, files.runtime), createLocalRuntimeModuleSource())
		const packageModules = await writePackageModuleFiles(workDir, packageGraph)
		const configPath = join(workDir, 'config.capnp')
		await writeFile(
			configPath,
			createWorkerdConfig({
				bridgePort: bridge.port,
				files,
				packageModules,
				allowPrivateNetwork: input.allowPrivateNetwork,
			}),
		)

		const env: NodeJS.ProcessEnv = { ...process.env, [runSecretEnvVar]: runSecret }
		delete env[apiTokenEnvVar]
		child = spawn(workerdPath, ['serve', configPath, '--control-fd=3'], {
			cwd: workDir,
			env,
			stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
		})
		const workerd = watchWorkerd(child)
		const started = await workerd.listening
		if ('exitDetail' in started) {
			return finish({ error: `Local execute could not load the module${started.exitDetail}` })
		}
		let response: { status: number; body: string }
		try {
			response = await postToWorkerd({
				port: started.port,
				runSecret,
				body: JSON.stringify({ params: input.params ?? {} }),
			})
		} catch (error) {
			const exitDetail = await Promise.race([workerd.exited, delay(workerdExitGraceMs, null)])
			if (exitDetail !== null) throw new Error(`workerd exited during the run${exitDetail}`)
			const reason = error instanceof Error ? error.message : String(error)
			throw new Error(`Local execute run failed (${reason}).${workerd.stderr()}`)
		}
		if (response.status !== 200) {
			throw new Error(`Local execute runtime returned HTTP ${response.status}.${workerd.stderr()}`)
		}
		return finish(JSON.parse(response.body) as SandboxResponse)
	} finally {
		releaseSignals()
		stopWorkerd()
		await bridge?.close()
		await rm(workDir, { recursive: true, force: true })
	}
}

async function writePackageModuleFiles(
	workDir: string,
	graph: LocalPackageGraph,
): Promise<Array<WorkerdPackageModuleFile>> {
	const written: Array<WorkerdPackageModuleFile> = []
	for (const [index, module] of graph.modules.entries()) {
		const file = `pkg-${index}.js`
		await writeFile(join(workDir, file), module.esModule)
		written.push({ name: module.name, file })
	}
	return written
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
			structuredContent: { ...base, returnedBytes: 0, error: sandbox.error, logs },
			isError: true,
		}
	}
	const text =
		typeof sandbox.result === 'string'
			? sandbox.result
			: (JSON.stringify(sandbox.result, null, 2) ?? 'undefined')
	const serialized =
		typeof sandbox.result === 'string'
			? sandbox.result
			: (JSON.stringify(sandbox.result) ?? 'undefined')
	return {
		content: [{ type: 'text', text }],
		structuredContent: {
			...base,
			returnedBytes: Buffer.byteLength(serialized),
			result: sandbox.result,
			logs,
		},
		isError: false,
	}
}

/**
 * `finally` does not run when the CLI is killed by a signal; without this,
 * workerd is orphaned and the user's module stays in the temp dir.
 */
function cleanupOnSignal(cleanup: () => void): () => void {
	const signals: Array<NodeJS.Signals> = ['SIGINT', 'SIGTERM', 'SIGHUP']
	const release = () => {
		for (const signal of signals) process.off(signal, handler)
	}
	const handler = (signal: NodeJS.Signals) => {
		release()
		cleanup()
		process.kill(process.pid, signal)
	}
	for (const signal of signals) process.once(signal, handler)
	return release
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
	const listening = new Promise<{ port: number } | { exitDetail: string }>((resolve, reject) => {
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
					resolve({ port })
				}
			}
		})
		child.once('error', (error) => {
			clearTimeout(timer)
			reject(new Error(`Could not start workerd: ${error.message}`))
		})
		void exited.then((exitDetail) => {
			clearTimeout(timer)
			resolve({ exitDetail })
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

/** node:http rather than fetch: local runs have no time limit, and fetch gives up after 300s. */
function postToWorkerd(input: {
	port: number
	runSecret: string
	body: string
}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: '127.0.0.1',
				port: input.port,
				method: 'POST',
				path: '/',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(input.body),
					[runSecretHeader]: input.runSecret,
				},
			},
			(response) => {
				readBody(response).then(
					(body) => resolve({ status: response.statusCode ?? 0, body }),
					reject,
				)
			},
		)
		request.on('error', reject)
		request.end(input.body)
	})
}

async function startBridge(input: {
	runSecret: string
	forward: (
		call: { path: Array<string>; args: Array<unknown> },
		signal: AbortSignal,
	) => Promise<unknown>
}): Promise<Bridge> {
	const inFlight = new AbortController()
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
			const result = await input.forward(call, inFlight.signal)
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
				inFlight.abort()
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

async function readBody(stream: IncomingMessage): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}
