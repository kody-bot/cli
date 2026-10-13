/**
 * Long-running `kody dev` app server: bundles `kody.app.entry` the same way
 * local-bundle/publish does for esbuild, serves via workerd, strips the mount
 * at the Node proxy, and rebuilds on file changes.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import {
	assertTokenSafeApiUrl,
	callCapabilityProxy,
} from './capability-proxy.js'
import { apiTokenEnvVar } from './defaults.js'
import { bundleLocalUserModule } from './local-bundle.js'
import { createWorkerdConfig } from './local-runtime-source.js'
import { buildLocalPackageContext } from './local-package-run.js'
import {
	createPackageAppEntrySource,
	createPackageLocalRuntimeModuleSource,
	runSecretEnvVar,
	runSecretHeader,
	type PackageLocalContext,
} from './package-local-runtime-source.js'
import type { KodyPackageManifest } from './package-manifest.js'
import { resolvePackagePath } from './package-manifest.js'
import { redact } from './redact.js'
import type { KodyTarget } from './target.js'
import { ensureWorkerdBinary } from './workerd-binary.js'

export type PackageAppDevOptions = {
	manifest: KodyPackageManifest
	token: string
	apiUrl: string
	target: KodyTarget
	host?: string
	port?: number
	/** Public mount path the Node proxy strips (default ''). */
	appBasePath?: string
	allowPrivateNetwork?: boolean
	workerdPath?: string
	fetchFn?: typeof fetch
	/** Hot reload via fs.watch (default true). One-shot `dev fetch` turns this off. */
	watch?: boolean
	onStatus?: (message: string) => void
	onError?: (message: string) => void
}

export type PackageAppDevServer = {
	url: string
	port: number
	hostedUrl: string
	appBasePath: string
	packageContext: PackageLocalContext
	fetchPath: (
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string },
	) => Promise<{ status: number; headers: Record<string, string>; body: string }>
	close: () => Promise<void>
}

type Bridge = { port: number; close: () => Promise<void> }

const workerdStartTimeoutMs = 30_000

export async function startPackageAppDev(
	options: PackageAppDevOptions,
): Promise<PackageAppDevServer> {
	if (!options.manifest.app?.entry) {
		throw new Error(
			'This package has no kody.app.entry. Add `"kody": { "app": { "entry": "./app/router.ts" } }` or use `kody dev job|webhook|emit|check`.',
		)
	}
	assertTokenSafeApiUrl(options.apiUrl)

	const host = options.host ?? '127.0.0.1'
	const appBasePath = normalizeBasePath(options.appBasePath ?? '')
	const runSecret = randomBytes(32).toString('hex')
	const workDir = await mkdtemp(join(tmpdir(), 'kody-dev-'))
	const workerdPath =
		options.workerdPath ??
		(await ensureWorkerdBinary({
			onDownload: (url) => options.onStatus?.(`Downloading workerd from ${url}…`),
		}))

	const client = {
		apiUrl: options.apiUrl,
		token: options.token,
		fetchFn: options.fetchFn,
	}

	let bridge: Bridge | undefined
	let child: ChildProcess | undefined
	let workerdPort: number | undefined
	let reloadTimer: NodeJS.Timeout | undefined
	let closed = false

	const proxy = createServer((req, res) => {
		void proxyRequest(req, res)
	})

	await new Promise<void>((resolve, reject) => {
		proxy.once('error', reject)
		proxy.listen(options.port ?? 0, host, () => resolve())
	})
	const address = proxy.address() as AddressInfo
	const hostedUrl = `http://${host}:${address.port}`
	const packageContext = buildLocalPackageContext({
		kodyId: options.manifest.kodyId,
		packageId: `local:${options.manifest.kodyId}`,
		hostedUrl,
		appBasePath,
	})

	bridge = await startBridge({
		runSecret,
		forward: (call, signal) =>
			callCapabilityProxy({
				...client,
				...call,
				signal,
			}),
	})

	const entryPath = resolvePackagePath(options.manifest, options.manifest.app.entry)

	async function rebuildAndServe(): Promise<void> {
		options.onStatus?.(`Bundling ${entryPath}…`)
		const code = await bundleLocalUserModule(entryPath)
		await writeWorkerFiles({
			workDir,
			code,
			packageContext,
			mockStorage: options.target === 'mock',
			bridgePort: bridge!.port,
			allowPrivateNetwork: options.allowPrivateNetwork,
		})
		await restartWorkerd()
	}

	async function restartWorkerd(): Promise<void> {
		if (child) {
			child.kill('SIGKILL')
			child = undefined
			workerdPort = undefined
		}
		const env: NodeJS.ProcessEnv = { ...process.env, [runSecretEnvVar]: runSecret }
		delete env[apiTokenEnvVar]
		const configPath = join(workDir, 'config.capnp')
		child = spawn(workerdPath, ['serve', configPath, '--control-fd=3'], {
			cwd: workDir,
			env,
			stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
		})
		const workerd = watchWorkerd(child)
		const started = await workerd.listening
		if ('exitDetail' in started) {
			throw new Error(`workerd failed to start${started.exitDetail}`)
		}
		workerdPort = started.port
		options.onStatus?.(`App ready at ${hostedUrl}${appBasePath || '/'}`)
	}

	async function proxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			if (!workerdPort) {
				res.writeHead(503, { 'content-type': 'text/plain' })
				res.end('Dev server is still starting.')
				return
			}
			const incomingUrl = new URL(req.url ?? '/', hostedUrl)
			const restPath = stripMount(incomingUrl.pathname, appBasePath)
			const forwardUrl = new URL(restPath + incomingUrl.search, `http://127.0.0.1:${workerdPort}`)

			const chunks: Array<Buffer> = []
			for await (const chunk of req) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
			}
			const body = Buffer.concat(chunks)

			const headers: Record<string, string | number | string[] | undefined> = {
				...req.headers,
				host: `127.0.0.1:${workerdPort}`,
				[runSecretHeader]: runSecret,
			}
			delete headers['content-length']

			await new Promise<void>((resolve, reject) => {
				const upstream = httpRequest(
					forwardUrl,
					{ method: req.method, headers },
					(upstreamRes) => {
						res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
						upstreamRes.pipe(res)
						upstreamRes.on('end', () => resolve())
						upstreamRes.on('error', reject)
					},
				)
				upstream.on('error', reject)
				if (body.length > 0) upstream.write(body)
				upstream.end()
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			options.onError?.(message)
			if (!res.headersSent) {
				res.writeHead(502, { 'content-type': 'text/plain' })
				res.end(`Dev proxy error: ${message}`)
			}
		}
	}

	await rebuildAndServe()

	const watcher =
		options.watch === false
			? null
			: watch(options.manifest.root, { recursive: true }, (_event, filename) => {
					if (closed) return
					if (filename && shouldIgnoreWatchPath(filename)) return
					clearTimeout(reloadTimer)
					reloadTimer = setTimeout(() => {
						void rebuildAndServe().catch((error) => {
							const message = error instanceof Error ? error.message : String(error)
							options.onError?.(message)
						})
					}, 120)
				})

	const fetchPath: PackageAppDevServer['fetchPath'] = async (path, init = {}) => {
		const url = new URL(joinUrlPath(appBasePath, path), hostedUrl)
		const response = await fetch(url, {
			method: init.method ?? 'GET',
			headers: init.headers,
			body: init.body,
		})
		const body = await response.text()
		const headers: Record<string, string> = {}
		response.headers.forEach((value, key) => {
			headers[key] = value
		})
		return { status: response.status, headers, body }
	}

	return {
		url: hostedUrl,
		port: address.port,
		hostedUrl,
		appBasePath,
		packageContext,
		fetchPath,
		close: async () => {
			closed = true
			clearTimeout(reloadTimer)
			watcher?.close()
			const stopping = child
			if (stopping) {
				const exited = new Promise<void>((resolve) => {
					stopping.once('exit', () => resolve())
					stopping.once('error', () => resolve())
				})
				stopping.kill('SIGKILL')
				await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 1000))])
				child = undefined
			}
			await bridge?.close()
			await new Promise<void>((resolve) => {
				proxy.close(() => resolve())
			})
			await rm(workDir, { recursive: true, force: true })
		},
	}
}

async function writeWorkerFiles(input: {
	workDir: string
	code: string
	packageContext: PackageLocalContext
	mockStorage: boolean
	bridgePort: number
	allowPrivateNetwork?: boolean
}): Promise<void> {
	await mkdir(input.workDir, { recursive: true })
	const files = { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' }
	await writeFile(join(input.workDir, files.entry), createPackageAppEntrySource())
	await writeFile(join(input.workDir, files.user), input.code)
	await writeFile(
		join(input.workDir, files.runtime),
		createPackageLocalRuntimeModuleSource({
			packageContext: input.packageContext,
			mockStorage: input.mockStorage,
		}),
	)
	await writeFile(
		join(input.workDir, 'config.capnp'),
		createWorkerdConfig({
			bridgePort: input.bridgePort,
			files,
			allowPrivateNetwork: input.allowPrivateNetwork,
		}),
	)
}

function normalizeBasePath(value: string): string {
	const trimmed = value.trim()
	if (!trimmed || trimmed === '/') return ''
	const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
	return withSlash.replace(/\/+$/, '')
}

function stripMount(pathname: string, appBasePath: string): string {
	if (!appBasePath) return pathname || '/'
	if (pathname === appBasePath) return '/'
	if (pathname.startsWith(`${appBasePath}/`)) {
		return pathname.slice(appBasePath.length) || '/'
	}
	return pathname || '/'
}

function joinUrlPath(base: string, path: string): string {
	const rest = path.startsWith('/') ? path : `/${path}`
	if (!base) return rest
	return `${base}${rest === '/' ? '' : rest}` || base
}

function shouldIgnoreWatchPath(filename: string): boolean {
	return (
		filename.includes('node_modules') ||
		filename.includes('.git') ||
		filename.endsWith('.map') ||
		filename.startsWith('.')
	)
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
			const parsed = JSON.parse(await readBody(request)) as {
				path?: unknown
				args?: unknown
			}
			if (
				!Array.isArray(parsed.path) ||
				parsed.path.length === 0 ||
				!parsed.path.every((segment) => typeof segment === 'string')
			) {
				throw new Error('Invalid kody:runtime call path.')
			}
			const result = await input.forward(
				{
					path: parsed.path as Array<string>,
					args: Array.isArray(parsed.args) ? parsed.args : [],
				},
				inFlight.signal,
			)
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

async function readBody(stream: IncomingMessage): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}
