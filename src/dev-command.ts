/**
 * `kody dev` and its agent-facing subcommands: serve, fetch, job, webhook,
 * emit, check. Covers the four package surfaces: exports (via execute/invoke
 * against the local package), webhooks, schedules (job once), and subscriptions.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildLocalPackageContext, runLocalPackageModule } from './local-package-run.js'
import { ensureMockTarget, type MockServer } from './mock/mock-server.js'
import { startPackageAppDev, type PackageAppDevServer } from './package-app-dev.js'
import {
	loadPackageManifest,
	resolveExportModulePath,
	resolvePackagePath,
	type KodyPackageManifest,
} from './package-manifest.js'
import { StructuredCliError } from './structured-error.js'
import type { KodyTarget } from './target.js'
import { formatToolResult } from './tool-result.js'
import { bundleLocalUserModule } from './local-bundle.js'

export type DevIo = {
	stdout: (text: string) => void
	stderr: (text: string) => void
}

export type DevAuth = {
	token: string
	apiUrl: string
	/** User-owned token org selection (`?org=`) for --target prod hops. */
	org?: string
	/**
	 * When target is mock: fetch stamped `kody:@` modules from prod while
	 * CapabilityProxy stays on the mock.
	 */
	depResolve?: {
		apiUrl: string
		token: string
		org?: string
	}
	/** Hosts allowed for real network when `.kody/mocks.ts` is active (mock only). */
	passthroughHosts?: ReadonlyArray<string>
	/** Present when target is mock and this command started (or reused) it. */
	mockServer?: MockServer
	closeMock?: () => Promise<void>
}

export async function resolveDevAuth(input: {
	target: KodyTarget
	token: string
	apiUrl: string
	org?: string
	resetStorage?: boolean
	sessionId?: string
	packageId?: string
	depResolve?: DevAuth['depResolve']
	passthroughHosts?: ReadonlyArray<string>
}): Promise<DevAuth> {
	if (input.target !== 'mock') {
		return {
			token: input.token,
			apiUrl: input.apiUrl,
			...(input.org ? { org: input.org } : {}),
			...(input.passthroughHosts?.length
				? { passthroughHosts: input.passthroughHosts }
				: {}),
		}
	}
	const ensured = await ensureMockTarget({
		sessionId: input.sessionId,
		resetStorage: input.resetStorage,
		packageId: input.packageId,
	})
	let mockClosed = false
	return {
		token: ensured.token,
		apiUrl: ensured.apiUrl,
		...(input.org ? { org: input.org } : {}),
		...(input.depResolve ? { depResolve: input.depResolve } : {}),
		...(input.passthroughHosts?.length
			? { passthroughHosts: input.passthroughHosts }
			: {}),
		mockServer: ensured.server,
		closeMock: ensured.started
			? async () => {
					if (mockClosed) return
					mockClosed = true
					await ensured.server.close()
				}
			: undefined,
	}
}

export async function runDevServe(input: {
	target: KodyTarget
	auth: DevAuth
	port?: number
	appBasePath?: string
	allowPrivateNetwork?: boolean
	passthroughHosts?: ReadonlyArray<string>
	cwd?: string
	io: DevIo
	/** Injected for tests — when set, serve returns immediately after start. */
	serveOnce?: boolean
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const server = await startPackageAppDev({
		manifest,
		token: input.auth.token,
		apiUrl: input.auth.apiUrl,
		target: input.target,
		port: input.port,
		appBasePath: input.appBasePath,
		...(input.auth.org ? { org: input.auth.org } : {}),
		...(input.auth.depResolve ? { depResolve: input.auth.depResolve } : {}),
		...(input.passthroughHosts?.length
			? { passthroughHosts: input.passthroughHosts }
			: input.auth.passthroughHosts?.length
				? { passthroughHosts: input.auth.passthroughHosts }
				: {}),
		allowPrivateNetwork: input.allowPrivateNetwork,
		onStatus: (message) => input.io.stderr(`${message}\n`),
		onError: (message) => input.io.stderr(`${message}\n`),
	})
	input.io.stdout(
		`kody dev listening on ${server.hostedUrl}${server.appBasePath || '/'}\n` +
			`target: ${input.target}\n` +
			`package: ${manifest.name} (${manifest.kodyId})\n` +
			`Agents: kody dev fetch /path | job <name> | webhook <name> --body file.json | emit <event> --body file.json | check\n`,
	)
	if (input.serveOnce) {
		await server.close()
		await input.auth.closeMock?.()
		return 0
	}
	await new Promise<void>((resolveWait) => {
		const stop = async () => {
			process.off('SIGINT', onSig)
			process.off('SIGTERM', onSig)
			await server.close()
			await input.auth.closeMock?.()
			resolveWait()
		}
		const onSig = () => {
			void stop()
		}
		process.on('SIGINT', onSig)
		process.on('SIGTERM', onSig)
	})
	return 0
}

export async function runDevFetch(input: {
	target: KodyTarget
	auth: DevAuth
	path: string
	method?: string
	body?: string
	port?: number
	appBasePath?: string
	cwd?: string
	json?: boolean
	io: DevIo
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const server = await startPackageAppDev({
		manifest,
		token: input.auth.token,
		apiUrl: input.auth.apiUrl,
		target: input.target,
		port: input.port,
		appBasePath: input.appBasePath,
		...(input.auth.org ? { org: input.auth.org } : {}),
		...(input.auth.depResolve ? { depResolve: input.auth.depResolve } : {}),
		...(input.auth.passthroughHosts?.length
			? { passthroughHosts: input.auth.passthroughHosts }
			: {}),
		watch: false,
		onStatus: (message) => input.io.stderr(`${message}\n`),
		onError: (message) => input.io.stderr(`${message}\n`),
	})
	try {
		const result = await server.fetchPath(input.path, {
			method: input.method,
			body: input.body,
			headers: input.body
				? { 'content-type': 'application/json' }
				: undefined,
		})
		if (input.json) {
			input.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
		} else {
			input.io.stdout(`HTTP ${result.status}\n${result.body}\n`)
		}
		return result.status >= 400 ? 1 : 0
	} finally {
		await server.close()
		await input.auth.closeMock?.()
	}
}

export async function runDevJob(input: {
	target: KodyTarget
	auth: DevAuth
	jobName: string
	cwd?: string
	json?: boolean
	dryRun?: boolean
	io: DevIo
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const job = manifest.jobs[input.jobName]
	if (!job) {
		throw new StructuredCliError({
			code: 'dev_surface_missing',
			message: `No job named ${JSON.stringify(input.jobName)}.`,
			where: manifest.packageJsonPath,
			fix: `Known jobs: ${Object.keys(manifest.jobs).join(', ') || '(none)'}.`,
			target: input.target,
		})
	}
	const modulePath = resolvePackagePath(manifest, job.entry)
	if (input.dryRun) {
		return printDevDryRun({
			target: input.target,
			surface: `job:${input.jobName}`,
			modulePath,
			params: undefined,
			extra: {
				schedule: job.schedule,
				scheduleRaw: job.scheduleRaw,
				timezone: job.timezone ?? null,
				enabled: job.enabled ?? null,
			},
			json: input.json,
			io: input.io,
			closeMock: input.auth.closeMock,
		})
	}
	// Scheduler contract: no params. Never schedules locally — runs once.
	return await runPackageModuleOnce({
		manifest,
		modulePath,
		params: undefined,
		target: input.target,
		auth: input.auth,
		json: input.json,
		io: input.io,
		surface: `job:${input.jobName}`,
	})
}

export async function runDevWebhook(input: {
	target: KodyTarget
	auth: DevAuth
	webhookName: string
	bodyPath: string
	cwd?: string
	json?: boolean
	dryRun?: boolean
	io: DevIo
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const webhook = manifest.webhooks[input.webhookName]
	if (!webhook) {
		throw new StructuredCliError({
			code: 'dev_surface_missing',
			message: `No webhook named ${JSON.stringify(input.webhookName)}.`,
			where: manifest.packageJsonPath,
			fix: `Known webhooks: ${Object.keys(manifest.webhooks).join(', ') || '(none)'}.`,
			target: input.target,
		})
	}
	const rawBody = await readFile(resolve(input.cwd ?? process.cwd(), input.bodyPath), 'utf8')
	let jsonBody: unknown = null
	try {
		jsonBody = JSON.parse(rawBody)
	} catch {
		jsonBody = null
	}
	const params =
		webhook.inputMode === 'params'
			? (jsonBody ?? {})
			: {
					webhook: {
						packageKodyId: manifest.kodyId,
						name: input.webhookName,
						receivedAt: new Date().toISOString(),
					},
					request: {
						method: 'POST',
						contentType: 'application/json',
						headers: { 'content-type': 'application/json' },
						body: rawBody,
						json: jsonBody,
					},
					synthetic: true as const,
				}
	const modulePath = resolveExportModulePath(manifest, webhook.export)
	if (input.dryRun) {
		return printDevDryRun({
			target: input.target,
			surface: `webhook:${input.webhookName}`,
			modulePath,
			params,
			extra: { export: webhook.export, bodyPath: input.bodyPath },
			json: input.json,
			io: input.io,
			closeMock: input.auth.closeMock,
		})
	}
	return await runPackageModuleOnce({
		manifest,
		modulePath,
		params,
		target: input.target,
		auth: input.auth,
		json: input.json,
		io: input.io,
		surface: `webhook:${input.webhookName}`,
	})
}

/**
 * Deliver an event to the local subscription handler in the platform's delivery
 * shape. On mock, any event type is allowed (handler may still validate).
 */
export async function runDevEmit(input: {
	target: KodyTarget
	auth: DevAuth
	event: string
	bodyPath: string
	cwd?: string
	json?: boolean
	dryRun?: boolean
	io: DevIo
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const subscription = manifest.subscriptions[input.event]
	if (!subscription) {
		if (input.target !== 'mock') {
			throw new StructuredCliError({
				code: 'dev_surface_missing',
				message: `No subscription for event ${JSON.stringify(input.event)}.`,
				where: manifest.packageJsonPath,
				fix: `Known subscriptions: ${Object.keys(manifest.subscriptions).join(', ') || '(none)'}. On --target mock you can still declare the handler first.`,
				target: input.target,
			})
		}
		throw new StructuredCliError({
			code: 'dev_surface_missing',
			message: `No subscription for event ${JSON.stringify(input.event)} in package.json#kody.subscriptions.`,
			where: manifest.packageJsonPath,
			fix: `Add a handler under kody.subscriptions[${JSON.stringify(input.event)}], then retry. Mock allows any event type once declared.`,
			target: input.target,
		})
	}
	const rawBody = await readFile(resolve(input.cwd ?? process.cwd(), input.bodyPath), 'utf8')
	let envelope: Record<string, unknown>
	try {
		const parsed = JSON.parse(rawBody) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('body must be a JSON object')
		}
		envelope = { ...(parsed as Record<string, unknown>) }
	} catch (error) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: `Could not parse event body ${input.bodyPath} as a JSON object.`,
			fix: 'Pass --body event.json with the platform delivery envelope fields.',
			details: { cause: error instanceof Error ? error.message : String(error) },
			target: input.target,
		})
	}
	// Platform delivery shape: caller body is the handler params; mark synthetic.
	if (typeof envelope.event !== 'string') {
		envelope.event = input.event
	}
	envelope.synthetic = true
	if (envelope.idempotency_key === undefined) {
		envelope.idempotency_key = `synthetic:local:${Date.now()}`
	}
	const modulePath = resolvePackagePath(manifest, subscription.handler)
	if (input.dryRun) {
		return printDevDryRun({
			target: input.target,
			surface: `subscription:${input.event}`,
			modulePath,
			params: envelope,
			extra: { handler: subscription.handler, bodyPath: input.bodyPath },
			json: input.json,
			io: input.io,
			closeMock: input.auth.closeMock,
		})
	}
	return await runPackageModuleOnce({
		manifest,
		modulePath,
		params: envelope,
		target: input.target,
		auth: input.auth,
		json: input.json,
		io: input.io,
		surface: `subscription:${input.event}`,
	})
}

/**
 * Bundle the package surfaces + light publish validations without running them.
 */
export async function runDevCheck(input: {
	target: KodyTarget
	cwd?: string
	json?: boolean
	io: DevIo
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const checks: Array<{ name: string; ok: boolean; detail?: string }> = []

	const push = (name: string, ok: boolean, detail?: string) => {
		checks.push({ name, ok, detail })
	}

	push('package.json', true, manifest.name)
	push('kody.id', Boolean(manifest.kodyId), manifest.kodyId)

	try {
		await readFile(resolve(manifest.root, 'README.md'))
		push('README.md', true)
	} catch {
		push('README.md', false, 'Publish requires README.md')
	}
	try {
		await readFile(resolve(manifest.root, 'AGENTS.md'))
		push('AGENTS.md', true)
	} catch {
		push('AGENTS.md', false, 'Publish requires AGENTS.md')
	}

	if (manifest.app?.entry) {
		try {
			const path = resolvePackagePath(manifest, manifest.app.entry)
			await bundleLocalUserModule(path)
			push('app.entry bundle', true, path)
		} catch (error) {
			push(
				'app.entry bundle',
				false,
				error instanceof Error ? error.message : String(error),
			)
		}
	} else {
		push('app.entry', true, 'none (ok)')
	}

	for (const [name, job] of Object.entries(manifest.jobs)) {
		try {
			await bundleLocalUserModule(resolvePackagePath(manifest, job.entry))
			push(`job:${name}`, true)
		} catch (error) {
			push(`job:${name}`, false, error instanceof Error ? error.message : String(error))
		}
	}
	for (const [name, webhook] of Object.entries(manifest.webhooks)) {
		try {
			await bundleLocalUserModule(resolveExportModulePath(manifest, webhook.export))
			push(`webhook:${name}`, true)
		} catch (error) {
			push(`webhook:${name}`, false, error instanceof Error ? error.message : String(error))
		}
	}
	for (const [topic, sub] of Object.entries(manifest.subscriptions)) {
		try {
			await bundleLocalUserModule(resolvePackagePath(manifest, sub.handler))
			push(`subscription:${topic}`, true)
		} catch (error) {
			push(
				`subscription:${topic}`,
				false,
				error instanceof Error ? error.message : String(error),
			)
		}
	}
	for (const [key, rel] of Object.entries(manifest.exports)) {
		try {
			await bundleLocalUserModule(resolvePackagePath(manifest, rel))
			push(`export:${key}`, true)
		} catch (error) {
			push(`export:${key}`, false, error instanceof Error ? error.message : String(error))
		}
	}

	const failed = checks.filter((check) => !check.ok)
	if (input.json) {
		input.io.stdout(
			`${JSON.stringify({ target: input.target, checks, ok: failed.length === 0 }, null, 2)}\n`,
		)
	} else {
		for (const check of checks) {
			const mark = check.ok ? 'ok' : 'FAIL'
			input.io.stdout(
				`${mark.padEnd(4)} ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`,
			)
		}
		input.io.stdout(
			failed.length === 0
				? `kody dev check passed (${checks.length} checks, target ${input.target})\n`
				: `kody dev check failed: ${failed.length}/${checks.length}\n`,
		)
	}
	return failed.length === 0 ? 0 : 1
}

async function runPackageModuleOnce(input: {
	manifest: KodyPackageManifest
	modulePath: string
	params: unknown
	target: KodyTarget
	auth: DevAuth
	json?: boolean
	io: DevIo
	surface: string
}): Promise<number> {
	const packageContext = buildLocalPackageContext({
		kodyId: input.manifest.kodyId,
		hostedUrl: input.auth.apiUrl.startsWith('http')
			? 'http://127.0.0.1:0'
			: 'http://127.0.0.1:0',
		appBasePath: '',
	})
	try {
		const result = await runLocalPackageModule({
			modulePath: input.modulePath,
			params: input.params,
			token: input.auth.token,
			apiUrl: input.auth.apiUrl,
			target: input.target,
			packageContext,
			packageRoot: input.manifest.root,
			...(input.auth.org ? { org: input.auth.org } : {}),
			...(input.auth.depResolve ? { depResolve: input.auth.depResolve } : {}),
			...(input.auth.passthroughHosts?.length
				? { passthroughHosts: input.auth.passthroughHosts }
				: {}),
			onStatus: (message) => input.io.stderr(`${message}\n`),
		})
		input.io.stdout(formatToolResult(result, input.json === true))
		return result.isError ? 1 : 0
	} finally {
		await input.auth.closeMock?.()
	}
}

/**
 * Show what `kody dev job|webhook|emit` would run without invoking the module
 * (safe against prod side effects).
 */
async function printDevDryRun(input: {
	target: KodyTarget
	surface: string
	modulePath: string
	params: unknown
	extra?: Record<string, unknown>
	json?: boolean
	io: DevIo
	closeMock?: () => Promise<void>
}): Promise<number> {
	try {
		const plan = {
			dryRun: true,
			wouldInvoke: true,
			target: input.target,
			surface: input.surface,
			modulePath: input.modulePath,
			params: input.params ?? null,
			...(input.extra ?? {}),
			note:
				input.target === 'prod'
					? 'No module run and no prod side effects. Drop --dry-run to invoke once against prod CapabilityProxy.'
					: 'No module run. Drop --dry-run to invoke against the selected target.',
		}
		if (input.json) {
			input.io.stdout(`${JSON.stringify(plan, null, 2)}\n`)
		} else {
			input.io.stdout(
				`dry-run: would invoke ${input.surface} on --target ${input.target}\n` +
					`module: ${input.modulePath}\n` +
					`params: ${JSON.stringify(input.params ?? null, null, 2)}\n` +
					(input.extra
						? `detail: ${JSON.stringify(input.extra, null, 2)}\n`
						: '') +
					`${plan.note}\n`,
			)
		}
		return 0
	} finally {
		await input.closeMock?.()
	}
}

/** Parse `kody dev` argv after the `dev` token. */
export function parseDevSubcommand(positionals: Array<string>): {
	subcommand: 'serve' | 'fetch' | 'job' | 'webhook' | 'emit' | 'check'
	rest: Array<string>
} {
	const raw = positionals[0]
	if (!raw || raw.startsWith('-')) {
		return { subcommand: 'serve', rest: positionals }
	}
	switch (raw) {
		case 'serve':
		case 'fetch':
		case 'job':
		case 'webhook':
		case 'emit':
		case 'check':
			return { subcommand: raw, rest: positionals.slice(1) }
		default:
			throw new Error(
				`Unknown kody dev subcommand ${JSON.stringify(raw)}. Use serve | fetch | job | webhook | emit | check.`,
			)
	}
}

void (null as unknown as PackageAppDevServer)
