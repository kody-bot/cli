import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	apiUrlFrom,
	buildExecuteToolArgs,
	executeSourcesConflict,
	resolveApiToken,
	resolveCommand,
	runCli,
} from '../src/cli.js'
import { modernMcpProtocolVersion } from '../src/defaults.js'
import { formatToolResult, listKodyTools } from '../src/mcp.js'
import { redact } from '../src/redact.js'
import { createFileBackend, saveCredentials } from '../src/store.js'

test('resolveCommand maps subcommands and flags', () => {
	assert.equal(resolveCommand(['search', 'what can you do']).command, 'search')
	assert.equal(resolveCommand(['install', '--yes']).command, 'install')
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

test('resolveCommand parses execute --local flags', () => {
	const { values } = resolveCommand([
		'execute',
		'--local',
		'--token',
		'tok',
		'--api-url',
		'http://localhost:8787',
		'--file',
		'mod.js',
	])
	assert.equal(values.local, true)
	assert.equal(values.token, 'tok')
	assert.equal(values['api-url'], 'http://localhost:8787')
})

test('resolveApiToken prefers --token, falls back to KODY_API_TOKEN, and requires one', () => {
	assert.equal(resolveApiToken({ token: 'flag' }, { KODY_API_TOKEN: 'env' }), 'flag')
	assert.equal(resolveApiToken({}, { KODY_API_TOKEN: ' env ' }), 'env')
	assert.throws(() => resolveApiToken({}, {}), /pass --token or set KODY_API_TOKEN/)
})

test('apiUrlFrom defaults to api.kody.codes', () => {
	assert.equal(apiUrlFrom({}, {}), 'https://api.kody.codes')
	assert.equal(apiUrlFrom({}, { KODY_API_URL: 'http://localhost:8787' }), 'http://localhost:8787')
	assert.equal(apiUrlFrom({ apiUrl: 'http://x' }, { KODY_API_URL: 'http://y' }), 'http://x')
})

test('execute rejects --token without --local and --invoke with --local', async () => {
	const run = async (argv: Array<string>) => {
		let stderr = ''
		const code = await runCli(argv, { stdout: () => {}, stderr: (text) => (stderr += text) })
		return { code, stderr }
	}
	const tokenOnly = await run(['execute', '--token', 'tok', '--code', 'export default () => 1'])
	assert.equal(tokenOnly.code, 1)
	assert.match(tokenOnly.stderr, /--token is only used with execute --local/)
	const invokeLocal = await run(['execute', '--local', '--invoke', 'kody:@me/pkg/export'])
	assert.equal(invokeLocal.code, 1)
	assert.match(invokeLocal.stderr, /--local runs a module you provide/)
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
