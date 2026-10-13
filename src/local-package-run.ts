/**
 * Run one unpublished package module (export / job / webhook / subscription)
 * in local workerd against `--target prod|mock`.
 */

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
} from './capability-proxy.js'
import { apiTokenEnvVar } from './defaults.js'
import { bundleLocalUserModule } from './local-bundle.js'
import {
	createWorkerdConfig,
	type WorkerdPackageModuleFile,
} from './local-runtime-source.js'
import {
	createPackageLocalRuntimeModuleSource,
	createPackageModuleEntrySource,
	localWorkerModuleNames,
	runSecretEnvVar,
	runSecretHeader,
	type PackageLocalContext,
} from './package-local-runtime-source.js'
import { redact } from './redact.js'
import type { KodyTarget } from './target.js'
import type { ToolCallResult } from './tool-result.js'
import { ensureWorkerdBinary } from './workerd-binary.js'

export type LocalPackageRunInput = {
	modulePath: string
	params?: unknown
	token: string
	apiUrl: string
	target: KodyTarget
	packageContext: PackageLocalContext
	fetchFn?: typeof fetch
	workerdPath?: string
	allowPrivateNetwork?: boolean
	onStatus?: (message: string) => void
}

type SandboxResponse = { result?: unknown; error?: string; logs?: Array<string> }
type Bridge = { port: number; close: () => Promise<void> }

const workerdStartTimeoutMs = 30_000
const workerdExitGraceMs = 1_000

export async function runLocalPackageModule(
	input: LocalPackageRunInput,
): Promise<ToolCallResult> {
	assertTokenSafeApiUrl(input.apiUrl)
	input.onStatus?.(`Bundling ${input.modulePath}…`)
	const code = await bundleLocalUserModule(input.modulePath)
	const client = { apiUrl: input.apiUrl, token: input.token, fetchFn: input.fetchFn }

	const workerdPath =
		input.workerdPath ??
		(await ensureWorkerdBinary({
			onDownload: (url) => input.onStatus?.(`Downloading workerd from ${url}…`),
		}))

	const runSecret = randomBytes(32).toString('hex')
	const workDir = await mkdtemp(join(tmpdir(), 'kody-pkg-'))
	let child: ChildProcess | undefined
	let bridge: Bridge | undefined
	const stopWorkerd = () => child?.kill('SIGKILL')
	const releaseSignals = cleanupOnSignal(() => {
		stopWorkerd()
		rmSync(workDir, { recursive: true, force: true })
	})
	const startedAt = new Date()
	const finish = (sandbox: SandboxResponse): ToolCallResult => {
		const endedAt = new Date()
		const logs = sandbox.logs ?? []
		const base = {
			timing: {
				startedAt: startedAt.toISOString(),
				endedAt: endedAt.toISOString(),
				durationMs: endedAt.getTime() - startedAt.getTime(),
			},
			target: input.target,
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

	try {
		bridge = await startBridge({
			runSecret,
			forward: (call, signal) =>
				callCapabilityProxy({
					...client,
					...call,
					signal,
				}),
		})
		const files = { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' }
		await writeFile(join(workDir, files.entry), createPackageModuleEntrySource())
		await writeFile(join(workDir, files.user), code)
		await writeFile(
			join(workDir, files.runtime),
			createPackageLocalRuntimeModuleSource({
				packageContext: input.packageContext,
				mockStorage: input.target === 'mock',
			}),
		)
		const packageModules: Array<WorkerdPackageModuleFile> = []
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
			return finish({
				error: `Local package run could not load the module${started.exitDetail}`,
			})
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
			throw new Error(`Local package run failed (${reason}).${workerd.stderr()}`)
		}
		if (response.status !== 200) {
			throw new Error(
				`Local package runtime returned HTTP ${response.status}.${workerd.stderr()}`,
			)
		}
		return finish(JSON.parse(response.body) as SandboxResponse)
	} finally {
		releaseSignals()
		stopWorkerd()
		await bridge?.close()
		await rm(workDir, { recursive: true, force: true })
	}
}

/** Build the packageContext used for local unpublished package runs. */
export function buildLocalPackageContext(input: {
	kodyId: string
	packageId?: string
	hostedUrl: string
	appBasePath?: string
	clientModuleUrl?: string | null
}): PackageLocalContext {
	const appBasePath = input.appBasePath ?? ''
	return {
		packageId: input.packageId ?? `local:${input.kodyId}`,
		kodyId: input.kodyId,
		sourceId: `local:${input.kodyId}`,
		publishedCommit: null,
		appBasePath,
		hostedUrl: input.hostedUrl.replace(/\/+$/, ''),
		assetBasePath: appBasePath ? `${appBasePath}/_assets` : '/_assets',
		clientModuleUrl: input.clientModuleUrl ?? null,
	}
}

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

void localWorkerModuleNames
