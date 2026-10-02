import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runCli } from '../src/cli.js'
import {
	buildLocalExecuteResult,
	hasSavedPackageImports,
	runLocalExecute,
	savedPackageImportLocalResolveStatus,
} from '../src/local-execute.js'
import { createWorkerdConfig } from '../src/local-runtime-source.js'
import { localPackageGraphPath, localPackageGraphPlatformIssueUrl } from '../src/local-package-graph.js'

const goodToken = 'kody_tok_good'

test('workerd network access is public-only by default and keeps the loopback bridge', () => {
	const config = createWorkerdConfig({
		bridgePort: 4321,
		files: { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' },
	})
	assert.match(config, /allow = \["public"\]/)
	assert.match(config, /address = "127\.0\.0\.1:4321"/)
	assert.doesNotMatch(config, /allow = \["public", "private", "local"\]/)

	const privateNetworkConfig = createWorkerdConfig({
		bridgePort: 4321,
		files: { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' },
		allowPrivateNetwork: true,
	})
	assert.match(
		privateNetworkConfig,
		/allow = \["public", "private", "local"\]/,
	)
	assert.match(privateNetworkConfig, /address = "127\.0\.0\.1:4321"/)
})

type ProxyRequest = { method: string; url: string; authorization: string | null; body: unknown }

const proxyRequests: Array<ProxyRequest> = []
let sessionStatus: { status: number; body: unknown } = { status: 200, body: { scopes: [] } }
let apiUrl = ''
let server: Server

before(async () => {
	server = createServer(async (request, response) => {
		let raw = ''
		for await (const chunk of request) raw += chunk
		const body = raw ? JSON.parse(raw) : null
		proxyRequests.push({
			method: request.method ?? '',
			url: request.url ?? '',
			authorization: request.headers.authorization ?? null,
			body,
		})
		const send = (status: number, payload: unknown) => {
			response.writeHead(status, { 'content-type': 'application/json' })
			response.end(JSON.stringify(payload))
		}
		if (request.headers.authorization !== `Bearer ${goodToken}`) {
			send(401, { error: { code: 'invalid_token', message: 'unknown token' } })
			return
		}
		if (request.url === '/v1/capability-proxy/session') {
			send(sessionStatus.status, sessionStatus.body)
			return
		}
		if (request.url === '/v1/capability-proxy/call') {
			const { path, args } = body as { path: Array<string>; args: Array<unknown> }
			if (path.join('.') === 'kody.explode') {
				send(200, { error: { code: 'capability_failed', message: 'explode is broken' } })
				return
			}
			send(200, { result: { echoed: path.join('.'), args } })
			return
		}
		if (request.url === `/${localPackageGraphPath}`) {
			const payload = body as { code?: string; imports?: Array<string> }
			const imports = payload.imports ?? []
			if (imports.some((specifier) => specifier.includes('@missing/'))) {
				send(422, {
					error: {
						code: 'package_import_unresolved',
						message: 'Could not resolve saved package import kody:@missing/package/export.',
					},
				})
				return
			}
			if (imports.includes('kody:@test/pkg/hello')) {
				send(200, {
					imports: ['kody:@test/pkg/hello'],
					modules: [
						{
							name: 'kody:@test/pkg/hello',
							esModule: `export function greet(name) {
	return { hello: name, fromPackage: true }
}
export default greet
`,
						},
					],
				})
				return
			}
			send(404, { error: { code: 'not_found', message: 'package-graph not deployed' } })
			return
		}
		send(404, { error: 'not found' })
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
	server.closeAllConnections()
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

const hangAfterPing = `import { kody } from 'kody:runtime'
export default async function main() {
	await kody.ping({})
	return await new Promise((resolve) => setTimeout(resolve, 600_000))
}`

async function waitFor<T>(label: string, check: () => T | null | undefined): Promise<T> {
	for (let attempt = 0; attempt < 300; attempt++) {
		const value = check()
		if (value != null) return value
		await delay(100)
	}
	throw new Error(`Timed out waiting for ${label}`)
}

function workerdPidUnder(dir: string): number | null {
	const listing = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
	for (const line of listing.split('\n')) {
		if (line.includes('workerd') && line.includes(dir)) return Number(line.trim().split(/\s+/)[0])
	}
	return null
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function reset() {
	proxyRequests.length = 0
	sessionStatus = { status: 200, body: { scopes: ['capability-proxy'], expiresAt: null } }
}

test('hasSavedPackageImports detects static and dynamic kody:@ imports', () => {
	assert.equal(hasSavedPackageImports(`import skill from 'kody:@me/skills/get'`), true)
	assert.equal(hasSavedPackageImports(`const m = await import("kody:@me/skills/get")`), true)
	assert.equal(hasSavedPackageImports(`import { kody } from 'kody:runtime'`), false)
})

test(
	'runLocalExecute with kody:@ imports bundles package modules into local workerd',
	{ timeout: 180_000 },
	async () => {
		reset()
		const statuses: Array<string> = []
		const code = `import { greet } from 'kody:@test/pkg/hello'
export default async function main(params) {
	return greet(params.name)
}`
		const result = await runLocalExecute({
			code,
			params: { name: 'kent' },
			conversationId: 'conv-pkg',
			token: goodToken,
			apiUrl,
			onStatus: (message) => statuses.push(message),
		})
		assert.equal(result.isError, false)
		assert.ok(statuses.includes(savedPackageImportLocalResolveStatus))
		assert.deepEqual((result.structuredContent as { result: unknown }).result, {
			hello: 'kent',
			fromPackage: true,
		})
		assert.equal(proxyRequests[0]?.url, '/v1/capability-proxy/session')
		assert.equal(
			proxyRequests.some((request) => request.url === `/${localPackageGraphPath}`),
			true,
		)
		assert.equal(
			proxyRequests.every((request) => {
				if (request.url !== '/v1/capability-proxy/call') return true
				const path = (request.body as { path?: Array<string> } | null)?.path
				return !(Array.isArray(path) && path.join('.') === 'kody.execute')
			}),
			true,
			'must not hop the whole module to CapabilityProxy kody.execute',
		)
	},
)

test(
	'runLocalExecute with kody:@ imports fails clearly when the package cannot be resolved',
	{ timeout: 60_000 },
	async () => {
		reset()
		const code = `import missing from 'kody:@missing/package/export'
export default async function main() { return missing({}) }`
		await assert.rejects(
			() =>
				runLocalExecute({
					code,
					token: goodToken,
					apiUrl,
					workerdPath: '/nonexistent/workerd',
				}),
			/Could not resolve saved package import kody:@missing\/package\/export/,
		)
		assert.equal(
			proxyRequests.some((request) => request.url === '/v1/capability-proxy/call'),
			false,
		)
	},
)

test(
	'runLocalExecute with kody:@ imports fails clearly when package-graph API is missing',
	{ timeout: 60_000 },
	async () => {
		reset()
		const code = `import x from 'kody:@other/pkg/export'
export default async function main() { return x }`
		await assert.rejects(
			() =>
				runLocalExecute({
					code,
					token: goodToken,
					apiUrl,
					workerdPath: '/nonexistent/workerd',
				}),
			(error: unknown) => {
				assert.ok(error instanceof Error)
				assert.match(error.message, /will not silently fall back to cloud kody\.execute/)
				assert.match(
					error.message,
					new RegExp(localPackageGraphPlatformIssueUrl.replace(/\./g, '\\.')),
				)
				return true
			},
		)
	},
)

test('buildLocalExecuteResult matches the cloud execute envelope', () => {
	const startedAt = new Date('2026-09-30T00:00:00.000Z')
	const endedAt = new Date('2026-09-30T00:00:00.250Z')
	assert.deepEqual(
		buildLocalExecuteResult({ sandbox: { result: { ok: true }, logs: ['hi'] }, startedAt, endedAt }),
		{
			content: [{ type: 'text', text: '{\n  "ok": true\n}' }],
			structuredContent: {
				timing: {
					startedAt: '2026-09-30T00:00:00.000Z',
					endedAt: '2026-09-30T00:00:00.250Z',
					durationMs: 250,
				},
				returnedBytes: 11,
				result: { ok: true },
				logs: ['hi'],
			},
			isError: false,
		},
	)
	const failed = buildLocalExecuteResult({
		sandbox: { error: 'boom', logs: [] },
		startedAt,
		endedAt,
		conversationId: 'conv-1',
	})
	assert.equal(failed.isError, true)
	assert.deepEqual(failed.content, [{ type: 'text', text: 'Error: boom' }])
	assert.deepEqual(failed.structuredContent, {
		conversationId: 'conv-1',
		timing: {
			startedAt: '2026-09-30T00:00:00.000Z',
			endedAt: '2026-09-30T00:00:00.250Z',
			durationMs: 250,
		},
		returnedBytes: 0,
		error: 'boom',
		logs: [],
	})
	const text = buildLocalExecuteResult({ sandbox: { result: 'hé' }, startedAt, endedAt })
	assert.deepEqual(text.content, [{ type: 'text', text: 'hé' }])
	assert.equal((text.structuredContent as { returnedBytes: number }).returnedBytes, 3)
})

test(
	'runLocalExecute runs the module in workerd and proxies kody:runtime calls with the token',
	{ timeout: 180_000 },
	async () => {
		reset()
		const code = `
import { kody, workflows, packages, email } from 'kody:runtime'
export default async function main(params) {
	console.log('hello', params.name)
	console.warn('careful')
	const sent = await kody.emailSend({ to: params.name })
	const light = await kody.mcp.home.lights_on({ room: 'office' })
	const run = await workflows.create({ code: 'x' })
	let failure = null
	try {
		await kody.explode({})
	} catch (error) {
		failure = error.message
	}
	return { sent, light, run, packages, failure, email }
}
`
		const result = await runLocalExecute({
			code,
			params: { name: 'kent' },
			conversationId: 'conv-local',
			token: goodToken,
			apiUrl,
		})
		assert.equal(result.isError, false)
		const structured = result.structuredContent as Record<string, unknown>
		assert.deepEqual(structured.result, {
			sent: { echoed: 'kody.emailSend', args: [{ to: 'kent' }] },
			light: { echoed: 'kody.mcp.home.lights_on', args: [{ room: 'office' }] },
			run: { echoed: 'workflows.create', args: [{ code: 'x' }] },
			packages: null,
			failure: 'explode is broken',
			email: null,
		})
		assert.deepEqual(structured.logs, ['hello kent', '[warn] careful'])
		assert.equal(structured.conversationId, 'conv-local')
		assert.equal(proxyRequests[0]?.url, '/v1/capability-proxy/session')
		assert.equal(proxyRequests.length, 5)
		for (const request of proxyRequests) {
			assert.equal(request.authorization, `Bearer ${goodToken}`)
		}
		assert.deepEqual(proxyRequests[1]?.body, {
			path: ['kody', 'emailSend'],
			args: [{ to: 'kent' }],
			conversationId: 'conv-local',
		})
	},
)

test(
	'runLocalExecute reports module errors like cloud execute',
	{ timeout: 180_000 },
	async () => {
		reset()
		const thrown = await runLocalExecute({
			code: `export default async function main() { console.error('bad'); throw new Error('boom') }`,
			token: goodToken,
			apiUrl,
		})
		assert.equal(thrown.isError, true)
		assert.deepEqual(thrown.content, [{ type: 'text', text: 'Error: boom' }])
		assert.deepEqual((thrown.structuredContent as { logs: unknown }).logs, ['[error] bad'])

		const noDefault = await runLocalExecute({
			code: 'export const value = 1',
			token: goodToken,
			apiUrl,
		})
		assert.deepEqual(noDefault.content, [
			{ type: 'text', text: 'Error: Kody execute modules must default export a function.' },
		])

		const syntaxError = await runLocalExecute({
			code: 'export default () => {',
			token: goodToken,
			apiUrl,
		})
		assert.equal(syntaxError.isError, true)
		assert.match(
			String(syntaxError.content[0]?.text),
			/^Error: Local execute could not load the module \(workerd exit 1\)\n[\s\S]*SyntaxError/,
		)
	},
)

test('runLocalExecute stops before starting workerd when the token or flag is rejected', async () => {
	reset()
	const neverRuns = '/nonexistent/workerd'
	await assert.rejects(
		() =>
			runLocalExecute({
				code: 'export default () => 1',
				token: 'kody_at_revoked',
				apiUrl,
				workerdPath: neverRuns,
			}),
		/rejected the API token/,
	)
	sessionStatus = {
		status: 403,
		body: { error: { code: 'feature_disabled', message: 'local-execute is off' } },
	}
	await assert.rejects(
		() =>
			runLocalExecute({
				code: 'export default () => 1',
				token: goodToken,
				apiUrl,
				workerdPath: neverRuns,
			}),
		/feature flag `local-execute`/,
	)
	assert.ok(proxyRequests.every((request) => request.url === '/v1/capability-proxy/session'))
})

test(
	'kody execute --local with --token never requires MCP login',
	{ timeout: 180_000 },
	async () => {
		reset()
		const previousMcpUrl = process.env.KODY_MCP_URL
		process.env.KODY_MCP_URL = 'http://127.0.0.1:9/unreachable-mcp'
		let stdout = ''
		let stderr = ''
		try {
			const code = await runCli(
				[
					'execute',
					'--local',
					'--token',
					goodToken,
					'--api-url',
					apiUrl,
					'--params',
					'{"to":"me@example.com"}',
					'--code',
					"import { kody } from 'kody:runtime'\nexport default (params) => kody.emailSend(params)",
				],
				{ stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
			)
			assert.equal(code, 0, stderr)
		} finally {
			if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
			else process.env.KODY_MCP_URL = previousMcpUrl
		}
		assert.deepEqual(JSON.parse(stdout), {
			echoed: 'kody.emailSend',
			args: [{ to: 'me@example.com' }],
		})
		assert.equal(stdout.includes(goodToken), false)
	},
)

test(
	'runLocalExecute surfaces a workerd crash mid-run and cleans up',
	{ timeout: 180_000 },
	async () => {
		reset()
		const scratch = mkdtempSync(join(tmpdir(), 'kody-crash-'))
		const previousTmpdir = process.env.TMPDIR
		process.env.TMPDIR = scratch
		try {
			const run = runLocalExecute({ code: hangAfterPing, token: goodToken, apiUrl })
			await waitFor('the module to start', () =>
				proxyRequests.some((request) => request.url === '/v1/capability-proxy/call') ? true : null,
			)
			process.kill(await waitFor('workerd', () => workerdPidUnder(scratch)), 'SIGKILL')
			await assert.rejects(run, /workerd exited during the run \(workerd exit SIGKILL\)/)
		} finally {
			if (previousTmpdir === undefined) delete process.env.TMPDIR
			else process.env.TMPDIR = previousTmpdir
		}
		assert.deepEqual(readdirSync(scratch), [])
	},
)

test(
	'SIGTERM during kody execute --local stops workerd and removes the module',
	{ timeout: 180_000 },
	async () => {
		reset()
		const scratch = mkdtempSync(join(tmpdir(), 'kody-signal-'))
		const cli = spawn(
			process.execPath,
			['--import', 'tsx', 'src/bin.ts', 'execute', '--local', '--api-url', apiUrl, '--code', hangAfterPing],
			{
				env: { ...process.env, TMPDIR: scratch, KODY_API_TOKEN: goodToken },
				stdio: 'ignore',
			},
		)
		const exited = new Promise<NodeJS.Signals | null>((resolve) =>
			cli.once('exit', (_code, signal) => resolve(signal)),
		)
		await waitFor('the module to start', () =>
			proxyRequests.some((request) => request.url === '/v1/capability-proxy/call') ? true : null,
		)
		const workerdPid = await waitFor('workerd', () => workerdPidUnder(scratch))
		cli.kill('SIGTERM')
		assert.equal(await exited, 'SIGTERM')
		await waitFor('workerd to stop', () => (isRunning(workerdPid) ? null : true))
		assert.deepEqual(
			readdirSync(scratch).filter((entry) => entry.startsWith('kody-local-')),
			[],
		)
	},
)
