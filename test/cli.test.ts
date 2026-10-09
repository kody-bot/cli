import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	apiUrlFrom,
	buildExecuteToolArgs,
	executeSourcesConflict,
	parseApiParamsJson,
	resolveApiToken,
	resolveCommand,
	resolveLocalExecuteBearer,
	runCli,
	shouldUseApiToken,
} from '../src/cli.js'
import { isPairedApiUrl } from '../src/api-token.js'
import type { StoredApiToken } from '../src/api-token-store.js'
import { modernMcpProtocolVersion } from '../src/defaults.js'
import { formatToolResult, listKodyTools } from '../src/mcp.js'
import { clearOpenApiRouteCache } from '../src/open-api-client.js'
import { redact } from '../src/redact.js'
import {
	createFileBackend,
	fileStorePath,
	saveCredentials,
	type StoredCredentials,
} from '../src/store.js'

function sampleLoginCredentials(
	overrides: Partial<StoredCredentials> = {},
): StoredCredentials {
	return {
		version: 1,
		mcpUrl: 'https://kody.codes/mcp',
		resource: 'https://kody.codes/mcp',
		authorizationServerUrl: 'https://kody.codes',
		clientId: 'client-1',
		accessToken: 'oauth-access-from-login',
		refreshToken: 'refresh-1',
		tokenType: 'bearer',
		expiresAt: Date.now() + 120_000,
		scope: 'profile email',
		...overrides,
	}
}

test('resolveCommand maps subcommands and flags', () => {
	assert.equal(resolveCommand(['search', 'what can you do']).command, 'search')
	assert.equal(resolveCommand(['api', 'usageGet']).command, 'api')
	assert.equal(resolveCommand(['api', 'usageGet']).positionals[0], 'usageGet')
	assert.equal(resolveCommand(['install', '--yes']).command, 'install')
	assert.equal(resolveCommand(['auth', 'bootstrap', '--code', 'kody_bc_x']).command, 'auth')
	assert.equal(resolveCommand(['auth', 'bootstrap']).positionals[0], 'bootstrap')
	assert.equal(resolveCommand(['--help']).command, 'help')
	assert.equal(resolveCommand(['--version']).command, 'version')
	assert.equal(
		resolveCommand(['execute', '--file', 'mod.js']).values.file,
		'mod.js',
	)
	assert.equal(
		resolveCommand(['execute', '--invoke', 'kody:@scope/pkg/export']).values.invoke,
		'kody:@scope/pkg/export',
	)
	assert.throws(() => resolveCommand(['explode']), /Unknown command/)
})

test('parseApiParamsJson requires a flat object', () => {
	assert.deepEqual(parseApiParamsJson(undefined), {})
	assert.deepEqual(parseApiParamsJson('{"query":"email"}'), { query: 'email' })
	assert.throws(() => parseApiParamsJson('['), /valid JSON/)
	assert.throws(() => parseApiParamsJson('[]'), /JSON object/)
	assert.throws(() => parseApiParamsJson('"x"'), /JSON object/)
})

test('resolveCommand parses execute --local flags', () => {
	const { values } = resolveCommand([
		'execute',
		'--local',
		'--allow-private-network',
		'--token',
		'tok',
		'--api-url',
		'http://localhost:8787',
		'--file',
		'mod.js',
	])
	assert.equal(values.local, true)
	assert.equal(values['allow-private-network'], true)
	assert.equal(values.token, 'tok')
	assert.equal(values['api-url'], 'http://localhost:8787')
})

test('allow-private-network is limited to execute --local', async () => {
	let stderr = ''
	const code = await runCli(
		['execute', '--allow-private-network', '--code', 'export default () => 1'],
		{ stdout: () => {}, stderr: (text) => (stderr += text) },
	)
	assert.equal(code, 1)
	assert.match(stderr, /--allow-private-network can only be used with execute --local/)
})

test('resolveApiToken prefers --token, falls back to KODY_API_TOKEN, and requires one', () => {
	assert.equal(resolveApiToken({ token: 'flag' }, { KODY_API_TOKEN: 'env' }), 'flag')
	assert.equal(resolveApiToken({}, { KODY_API_TOKEN: ' env ' }), 'env')
	assert.throws(
		() => resolveApiToken({}, {}),
		/cliCredentialBootstrap[\s\S]*tokenCreate[\s\S]*org:execute[\s\S]*pass --token or set KODY_API_TOKEN/,
	)
})

test('resolveLocalExecuteBearer prefers API token over login OAuth', async () => {
	const token = await resolveLocalExecuteBearer({
		tokenValues: { token: 'kody_at_flag' },
		env: { KODY_API_TOKEN: 'kody_at_env' },
		ensureCredentials: async () => {
			throw new Error('login should not be consulted when a token is set')
		},
	})
	assert.equal(token, 'kody_at_flag')
})

test('resolveLocalExecuteBearer uses login OAuth when no API token is set', async () => {
	const token = await resolveLocalExecuteBearer({
		tokenValues: {},
		env: {},
		loadApiToken: () => null,
		ensureCredentials: async () => sampleLoginCredentials(),
	})
	assert.equal(token, 'oauth-access-from-login')
})

test('default paired API and MCP URLs allow login OAuth', async () => {
	let ensureCalls = 0
	const token = await resolveLocalExecuteBearer({
		tokenValues: {},
		env: {},
		loadApiToken: () => null,
		ensureCredentials: async () => {
			ensureCalls += 1
			return sampleLoginCredentials()
		},
	})
	assert.equal(token, 'oauth-access-from-login')
	assert.equal(ensureCalls, 1)
	assert.equal(isPairedApiUrl(), true)
})

test('mismatched API origin rejects login OAuth before ensure or fetch', async () => {
	let ensureCalls = 0
	let fetchCalls = 0
	await assert.rejects(
		() =>
			resolveLocalExecuteBearer({
				tokenValues: {},
				env: {},
				mcpUrl: 'https://kody.codes/mcp',
				apiUrl: 'https://api.other.test',
				loadApiToken: () => null,
				fetchFn: (async () => {
					fetchCalls += 1
					throw new Error('fetch must not run')
				}) as typeof fetch,
				ensureCredentials: async () => {
					ensureCalls += 1
					return sampleLoginCredentials()
				},
			}),
		/kody login credentials.*https:\/\/api\.kody\.codes.*api\.other\.test/,
	)
	assert.equal(ensureCalls, 0)
	assert.equal(fetchCalls, 0)
})

test('explicit and stored API tokens remain usable on mismatched origins', async () => {
	const apiUrl = 'https://api.other.test'
	const mcpUrl = 'https://kody.codes/mcp'
	const explicitToken = await resolveLocalExecuteBearer({
		tokenValues: { token: 'explicit-token' },
		env: {},
		mcpUrl,
		apiUrl,
		ensureCredentials: async () => {
			throw new Error('login OAuth must not be consulted')
		},
	})
	assert.equal(explicitToken, 'explicit-token')

	const envToken = await resolveLocalExecuteBearer({
		tokenValues: {},
		env: { KODY_API_TOKEN: 'env-token' },
		mcpUrl,
		apiUrl,
		ensureCredentials: async () => {
			throw new Error('login OAuth must not be consulted')
		},
	})
	assert.equal(envToken, 'env-token')

	const storedToken = await resolveLocalExecuteBearer({
		tokenValues: {},
		env: {},
		mcpUrl,
		apiUrl,
		loadApiToken: (requestedApiUrl) => ({
			version: 1,
			apiUrl: requestedApiUrl ?? apiUrl,
			token: 'stored-token',
			tokenId: 'stored-id',
		}),
		ensureCredentials: async () => {
			throw new Error('login OAuth must not be consulted')
		},
	})
	assert.equal(storedToken, 'stored-token')
})

test('paired preview and loopback API origins allow login OAuth', async () => {
	for (const [apiUrl, mcpUrl] of [
		[
			'https://kody-pr-42-api.kody.workers.dev',
			'https://kody-pr-42.kody.workers.dev/mcp',
		],
		['http://localhost:8788', 'http://127.0.0.1:8787/mcp'],
	]) {
		assert.equal(isPairedApiUrl(apiUrl, mcpUrl), true)
		const token = await resolveLocalExecuteBearer({
			tokenValues: {},
			env: {},
			apiUrl,
			mcpUrl,
			loadApiToken: () => null,
			ensureCredentials: async () => sampleLoginCredentials({ mcpUrl }),
		})
		assert.equal(token, 'oauth-access-from-login')
	}
	assert.equal(
		isPairedApiUrl(
			'https://api.kody-pr-42.kody.workers.dev',
			'https://kody-pr-42.kody.workers.dev/mcp',
		),
		false,
	)
	assert.equal(
		isPairedApiUrl(
			'https://unrelated-api.workers.dev',
			'https://kody-pr-42.kody.workers.dev/mcp',
		),
		false,
	)
})

test('resolveLocalExecuteBearer fails clearly when neither login nor token is available', async () => {
	await assert.rejects(
		() =>
			resolveLocalExecuteBearer({
				tokenValues: {},
				env: {},
				loadApiToken: () => null,
				ensureCredentials: async () => {
					throw new Error('Not logged in')
				},
			}),
		/execute --local needs auth[\s\S]*cliCredentialBootstrap[\s\S]*auth bootstrap[\s\S]*kody login[\s\S]*tokenCreate/,
	)
})

test('apiUrlFrom defaults to api.kody.codes', () => {
	assert.equal(apiUrlFrom({}, {}), 'https://api.kody.codes')
	assert.equal(apiUrlFrom({}, { KODY_API_URL: 'http://localhost:8787' }), 'http://localhost:8787')
	assert.equal(apiUrlFrom({ apiUrl: 'http://x' }, { KODY_API_URL: 'http://y' }), 'http://x')
})

test('shouldUseApiToken prefers explicit --token and env token when not logged in', () => {
	assert.equal(
		shouldUseApiToken({
			tokenValues: { token: 'flag' },
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: {},
			hasSession: true,
		}),
		true,
	)
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: { KODY_API_TOKEN: 'env-tok' },
			hasSession: false,
		}),
		true,
	)
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: { KODY_API_TOKEN: 'env-tok' },
			hasSession: true,
		}),
		false,
	)
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: {},
			hasSession: false,
		}),
		false,
	)
})

test('shouldUseApiToken treats stored bootstrap token like env when not logged in', () => {
	const stored: StoredApiToken = {
		version: 1,
		apiUrl: 'https://api.kody.codes',
		token: 'kody_at_stored',
		tokenId: 'tok_stored',
	}
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: {},
			hasSession: false,
			loadApiToken: () => stored,
		}),
		true,
	)
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: {},
			hasSession: true,
			loadApiToken: () => stored,
		}),
		false,
	)
})

test('resolveApiToken falls back to a stored bootstrap token', () => {
	const stored: StoredApiToken = {
		version: 1,
		apiUrl: 'https://api.kody.codes',
		token: 'kody_at_stored',
		tokenId: 'tok_stored',
	}
	assert.equal(
		resolveApiToken({}, {}, 'this command', {
			loadApiToken: () => stored,
		}),
		'kody_at_stored',
	)
})

test('api command calls Open API by operationId with scoped token', async () => {
	clearOpenApiRouteCache()
	const previousFetch = globalThis.fetch
	const calls: Array<string> = []
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new URL(String(input))
		calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`)
		if (url.pathname === '/openapi.json') {
			return new Response(
				JSON.stringify({
					paths: {
						'/v1/account/usage': { get: { operationId: 'usageGet' } },
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		if (url.pathname === '/v1/account/usage') {
			assert.equal(
				init?.headers && (init.headers as Record<string, string>).authorization,
				'Bearer kody_at_test',
			)
			return new Response(JSON.stringify({ plan: 'pro' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}
		return new Response('nope', { status: 404 })
	}) as typeof fetch
	let stdout = ''
	let stderr = ''
	try {
		const code = await runCli(
			[
				'api',
				'usageGet',
				'--params',
				'{}',
				'--token',
				'kody_at_test',
				'--api-url',
				'https://api.kody.codes',
			],
			{
				stdout: (text) => {
					stdout += text
				},
				stderr: (text) => {
					stderr += text
				},
			},
		)
		assert.equal(code, 0, stderr)
		assert.match(stdout, /"plan": "pro"/)
		assert.deepEqual(calls, ['GET /openapi.json', 'GET /v1/account/usage'])
	} finally {
		globalThis.fetch = previousFetch
		clearOpenApiRouteCache()
	}
})

test('api command refuses bootstrap redeem and documents auth bootstrap', async () => {
	let stderr = ''
	const code = await runCli(
		['api', 'cliCredentialBootstrapRedeem', '--params', '{"code":"kody_bc_x"}', '--token', 'tok'],
		{
			stdout: () => undefined,
			stderr: (text) => {
				stderr += text
			},
		},
	)
	assert.equal(code, 1)
	assert.match(stderr, /auth bootstrap --code/)
})

test('help documents the api command', async () => {
	let stdout = ''
	const code = await runCli(['help'], {
		stdout: (text) => {
			stdout += text
		},
	})
	assert.equal(code, 0)
	assert.match(stdout, /kody api <operationId>/)
	assert.match(stdout, /usageGet/)
})

test('execute with --token (no --local) uses CapabilityProxy and never requires login', async () => {
	const previousMcpUrl = process.env.KODY_MCP_URL
	process.env.KODY_MCP_URL = 'http://127.0.0.1:9/unreachable-mcp'
	const calls: Array<string> = []
	const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input)
		calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`)
		if (url.includes('/session')) {
			return new Response(JSON.stringify({ scopes: ['local-execute'] }), { status: 200 })
		}
		return new Response(
			JSON.stringify({ result: { ok: true, result: { cloud: true }, logs: [] } }),
			{ status: 200 },
		)
	}) as typeof fetch
	const previousFetch = globalThis.fetch
	globalThis.fetch = fetchFn
	let stdout = ''
	let stderr = ''
	try {
		const code = await runCli(
			[
				'execute',
				'--token',
				'tok',
				'--api-url',
				'https://api.kody.codes',
				'--code',
				'export default async () => ({ cloud: true })',
			],
			{ stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
		)
		assert.equal(code, 0, stderr)
	} finally {
		globalThis.fetch = previousFetch
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
	}
	assert.deepEqual(JSON.parse(stdout), { cloud: true })
	assert.ok(calls.some((call) => call.includes('/v1/capability-proxy/session')))
	assert.ok(calls.some((call) => call.includes('/v1/capability-proxy/call')))
	assert.equal(
		calls.some((call) => call.includes('unreachable-mcp')),
		false,
	)
})

test('execute without token or login prompts clearly', async () => {
	const previousMcpUrl = process.env.KODY_MCP_URL
	const previousToken = process.env.KODY_API_TOKEN
	process.env.KODY_MCP_URL = 'http://127.0.0.1:9/unreachable-mcp'
	delete process.env.KODY_API_TOKEN
	let stderr = ''
	try {
		const code = await runCli(['execute', '--code', 'export default () => 1'], {
			stdout: () => {},
			stderr: (text) => (stderr += text),
		})
		assert.equal(code, 1)
	} finally {
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
	}
	assert.match(stderr, /Not logged in, and no API token is set/)
	assert.match(stderr, /cliCredentialBootstrap|auth bootstrap/)
	assert.match(stderr, /tokenCreate/)
	assert.match(stderr, /org:execute/)
	assert.match(stderr, /KODY_API_TOKEN/)
	assert.match(stderr, /--token/)
})

test('execute --local without token or login fails clearly', async () => {
	const previousToken = process.env.KODY_API_TOKEN
	const previousXdg = process.env.XDG_CONFIG_HOME
	const xdg = mkdtempSync(join(tmpdir(), 'kody-cli-no-login-'))
	process.env.XDG_CONFIG_HOME = xdg
	delete process.env.KODY_API_TOKEN
	let stderr = ''
	try {
		const code = await runCli(
			['execute', '--local', '--code', 'export default () => 1'],
			{ stdout: () => {}, stderr: (text) => (stderr += text) },
		)
		assert.equal(code, 1)
	} finally {
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
	}
	assert.match(stderr, /execute --local needs auth/)
	assert.match(stderr, /cliCredentialBootstrap|auth bootstrap/)
	assert.match(stderr, /kody login/)
	assert.match(stderr, /tokenCreate|KODY_API_TOKEN/)
	assert.match(stderr, /pass --token or set KODY_API_TOKEN/)
	assert.doesNotMatch(stderr, /workerd did not start|Could not start workerd/)
})

test('execute --local with login (no API token) sends OAuth access token as Bearer', async () => {
	const previousToken = process.env.KODY_API_TOKEN
	const previousXdg = process.env.XDG_CONFIG_HOME
	const previousMcpUrl = process.env.KODY_MCP_URL
	const xdg = mkdtempSync(join(tmpdir(), 'kody-cli-login-local-'))
	process.env.XDG_CONFIG_HOME = xdg
	delete process.env.KODY_API_TOKEN
	const mcpUrl = 'https://login-local.test/mcp'
	process.env.KODY_MCP_URL = mcpUrl
	const credentials = sampleLoginCredentials({ mcpUrl, resource: mcpUrl })
	saveCredentials(credentials, createFileBackend(fileStorePath(mcpUrl)))

	const bearers: Array<string> = []
	const previousFetch = globalThis.fetch
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const headers = new Headers(init?.headers)
		bearers.push(headers.get('authorization') ?? '')
		return new Response(
			JSON.stringify({
				error: { code: 'feature_disabled', message: 'local-execute is off' },
			}),
			{ status: 403 },
		)
	}) as typeof fetch

	let stderr = ''
	try {
		const code = await runCli(
			[
				'execute',
				'--local',
				'--mcp-url',
				mcpUrl,
				'--api-url',
				'https://api.login-local.test',
				'--code',
				'export default () => 1',
			],
			{ stdout: () => {}, stderr: (text) => (stderr += text) },
		)
		assert.equal(code, 1)
	} finally {
		globalThis.fetch = previousFetch
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
	}
	assert.deepEqual(bearers, [`Bearer ${credentials.accessToken}`])
	assert.match(stderr, /feature_disabled[\s\S]*local-execute/)
	assert.equal(stderr.includes(credentials.accessToken), false)
})

test('execute --local prefers --token over a stored login session', async () => {
	const previousToken = process.env.KODY_API_TOKEN
	const previousXdg = process.env.XDG_CONFIG_HOME
	const previousMcpUrl = process.env.KODY_MCP_URL
	const xdg = mkdtempSync(join(tmpdir(), 'kody-cli-token-wins-'))
	process.env.XDG_CONFIG_HOME = xdg
	delete process.env.KODY_API_TOKEN
	const mcpUrl = 'https://token-wins.test/mcp'
	process.env.KODY_MCP_URL = mcpUrl
	saveCredentials(
		sampleLoginCredentials({
			mcpUrl,
			resource: mcpUrl,
			accessToken: 'oauth-should-not-win',
		}),
		createFileBackend(fileStorePath(mcpUrl)),
	)

	const bearers: Array<string> = []
	const previousFetch = globalThis.fetch
	globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		bearers.push(new Headers(init?.headers).get('authorization') ?? '')
		return new Response(
			JSON.stringify({
				error: { code: 'feature_disabled', message: 'local-execute is off' },
			}),
			{ status: 403 },
		)
	}) as typeof fetch

	let stderr = ''
	try {
		const code = await runCli(
			[
				'execute',
				'--local',
				'--token',
				'kody_at_explicit',
				'--mcp-url',
				mcpUrl,
				'--api-url',
				'https://api.kody.codes',
				'--code',
				'export default () => 1',
			],
			{ stdout: () => {}, stderr: (text) => (stderr += text) },
		)
		assert.equal(code, 1)
	} finally {
		globalThis.fetch = previousFetch
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
	}
	assert.deepEqual(bearers, ['Bearer kody_at_explicit'])
	assert.match(stderr, /feature_disabled/)
})

test('execute token paths surface feature_disabled and insufficient_scope', async () => {
	const previousToken = process.env.KODY_API_TOKEN
	delete process.env.KODY_API_TOKEN
	const previousFetch = globalThis.fetch
	const moduleArgs = ['--api-url', 'https://api.kody.codes', '--code', 'export default () => 1']
	const cases: Array<{ args: Array<string>; statusBody: unknown; pattern: RegExp }> = [
		{
			args: ['execute', '--local', '--token', 'tok', ...moduleArgs],
			statusBody: { error: { code: 'feature_disabled', message: 'local-execute is off' } },
			pattern: /feature_disabled[\s\S]*local-execute/,
		},
		{
			args: ['execute', '--local', '--token', 'tok', ...moduleArgs],
			statusBody: {
				error: {
					code: 'insufficient_scope',
					message: 'need local-execute',
					details: { required_scope: 'local-execute' },
				},
			},
			pattern: /insufficient_scope[\s\S]*cliCredentialBootstrap[\s\S]*tokenCreate[\s\S]*local-execute/,
		},
		{
			args: ['execute', '--token', 'tok', ...moduleArgs],
			statusBody: { error: { code: 'feature_disabled', message: 'local-execute is off' } },
			pattern: /feature_disabled[\s\S]*local-execute/,
		},
		{
			args: ['execute', '--token', 'tok', ...moduleArgs],
			statusBody: {
				error: {
					code: 'insufficient_scope',
					message: 'need email:send',
					details: { required_scopes: ['local-execute', 'email:send'] },
				},
			},
			pattern: /insufficient_scope[\s\S]*email:send[\s\S]*tokenCreate/,
		},
	]
	try {
		for (const entry of cases) {
			globalThis.fetch = (async () =>
				new Response(JSON.stringify(entry.statusBody), {
					status: 403,
					headers: { 'content-type': 'application/json' },
				})) as typeof fetch
			let stderr = ''
			const code = await runCli(entry.args, {
				stdout: () => {},
				stderr: (text) => (stderr += text),
			})
			assert.equal(code, 1, stderr)
			assert.match(stderr, entry.pattern)
		}
	} finally {
		globalThis.fetch = previousFetch
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
	}
})

test('execute rejects --invoke with --local', async () => {
	let stderr = ''
	const code = await runCli(['execute', '--local', '--invoke', 'kody:@me/pkg/export'], {
		stdout: () => {},
		stderr: (text) => (stderr += text),
	})
	assert.equal(code, 1)
	assert.match(stderr, /--local runs a module you provide/)
})

test('buildExecuteToolArgs passes invoke without code and keeps params', () => {
	assert.deepEqual(
		buildExecuteToolArgs({
			invoke: 'kody:@cameronpak/skills/skill-get',
			paramsJson: '{"name":"demo"}',
			conversationId: 'conv-1',
		}),
		{
			invoke: 'kody:@cameronpak/skills/skill-get',
			params: { name: 'demo' },
			conversationId: 'conv-1',
		},
	)
})

test('buildExecuteToolArgs rejects invoke combined with code', () => {
	assert.throws(
		() =>
			buildExecuteToolArgs({
				invoke: 'kody:@scope/pkg/export',
				code: 'export default async function main() {}',
			}),
		/--invoke cannot be combined/,
	)
})

test('executeSourcesConflict rejects invoke with code or file flags', () => {
	assert.equal(
		executeSourcesConflict({
			invoke: 'kody:@scope/pkg/export',
			hasCodeFlag: true,
			hasFileFlag: false,
			positionalModule: '',
		}),
		true,
	)
	assert.equal(
		executeSourcesConflict({
			invoke: 'kody:@scope/pkg/export',
			hasCodeFlag: false,
			hasFileFlag: true,
			positionalModule: '',
		}),
		true,
	)
	assert.equal(
		executeSourcesConflict({
			invoke: 'kody:@scope/pkg/export',
			hasCodeFlag: false,
			hasFileFlag: false,
			positionalModule: '',
		}),
		false,
	)
})

test('buildExecuteToolArgs errors when neither invoke nor code is provided', () => {
	assert.throws(() => buildExecuteToolArgs({}), /Provide --invoke, --code, --file/)
	assert.throws(() => buildExecuteToolArgs({ code: '' }), /Provide --invoke, --code, --file/)
	assert.throws(
		() => buildExecuteToolArgs({ invoke: '' }),
		/Provide a non-empty --invoke value/,
	)
})

test('formatToolResult prefers text content unless --json', () => {
	const result = {
		content: [{ type: 'text', text: 'hello' }],
		structuredContent: { ok: true },
	}
	assert.equal(formatToolResult(result, false), 'hello\n')
	assert.match(formatToolResult(result, true), /"ok": true/)
})

test('redact strips token-looking assignments', () => {
	assert.equal(
		redact('access_token=abc123 refresh_token: xyz'),
		'access_token=[redacted] refresh_token=[redacted]',
	)
})

test('CLI pins the stateless MCP protocol revision', () => {
	assert.equal(modernMcpProtocolVersion, '2026-07-28')
})

test('listKodyTools opens the 2026-07-28 lane with POST server/discover, never GET SSE', async () => {
	const backend = createFileBackend(join(mkdtempSync(join(tmpdir(), 'kody-cli-')), 'creds.json'))
	saveCredentials(
		{
			version: 1,
			mcpUrl: 'https://kody.codes/mcp',
			resource: 'https://kody.codes/mcp',
			authorizationServerUrl: 'https://kody.codes',
			clientId: 'client-1',
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			tokenType: 'bearer',
			expiresAt: Date.now() + 120_000,
			scope: 'profile email',
		},
		backend,
	)
	const requests: Array<{ method: string; mcpMethod: string | null; protocol: string | null }> =
		[]
	const fetchFn = (async (
		_input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		const headers = new Headers(init?.headers)
		requests.push({
			method: (init?.method ?? 'GET').toUpperCase(),
			mcpMethod: headers.get('mcp-method'),
			protocol: headers.get('mcp-protocol-version'),
		})
		return new Response('probe-closed', { status: 204 })
	}) as typeof fetch

	await assert.rejects(
		() => listKodyTools({ mcpUrl: 'https://kody.codes/mcp', backend, fetchFn }),
		/2026-07-28|server\/discover|negotiation/i,
	)
	assert.ok(requests.length > 0)
	assert.equal(
		requests.some((request) => request.method === 'GET'),
		false,
	)
	assert.deepEqual(requests[0], {
		method: 'POST',
		mcpMethod: 'server/discover',
		protocol: '2026-07-28',
	})
})
