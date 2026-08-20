import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCommand } from '../src/cli.js'
import { createMcpFetch, formatToolResult } from '../src/mcp.js'
import { redact } from '../src/redact.js'

test('resolveCommand maps subcommands and flags', () => {
	assert.equal(resolveCommand(['search', 'what can you do']).command, 'search')
	assert.equal(resolveCommand(['--help']).command, 'help')
	assert.equal(resolveCommand(['--version']).command, 'version')
	assert.equal(
		resolveCommand(['execute', '--file', 'mod.js']).values.file,
		'mod.js',
	)
	assert.throws(() => resolveCommand(['explode']), /Unknown command/)
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

test('createMcpFetch answers GET with 405 and forwards other methods', async () => {
	const calls: Array<string> = []
	const fetchFn = (async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
		return new Response('forwarded', { status: 200 })
	}) as typeof fetch
	const mcpFetch = createMcpFetch(fetchFn)

	const denied = await mcpFetch('https://kody.codes/mcp', { method: 'GET' })
	assert.equal(denied.status, 405)
	assert.deepEqual(calls, [])

	const posted = await mcpFetch('https://kody.codes/mcp', {
		method: 'POST',
		body: '{}',
	})
	assert.equal(posted.status, 200)
	assert.equal(await posted.text(), 'forwarded')
	assert.deepEqual(calls, ['POST https://kody.codes/mcp'])
})
