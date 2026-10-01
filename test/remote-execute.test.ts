import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	formatExecuteCapabilityResult,
	resolveRemoteExecuteCode,
	runRemoteExecuteWithToken,
} from '../src/remote-execute.js'
import {
	buildExecuteInvokePassthroughSource,
	parseExecuteInvokeSpecifier,
} from '../src/invoke-passthrough.js'

test('parseExecuteInvokeSpecifier normalizes @scope and hash exports', () => {
	assert.equal(
		parseExecuteInvokeSpecifier('kody:@scope/pkg/export'),
		'kody:@scope/pkg/export',
	)
	assert.equal(parseExecuteInvokeSpecifier('@scope/pkg#export'), 'kody:@scope/pkg/export')
	assert.throws(() => parseExecuteInvokeSpecifier('https://example.com/x'), /Unsupported/)
})

test('buildExecuteInvokePassthroughSource matches the MCP thin glue shape', () => {
	assert.equal(
		buildExecuteInvokePassthroughSource('kody:@me/pkg/export'),
		`import action from "kody:@me/pkg/export"

export default async function main(params) {
	return await action(params)
}`,
	)
})

test('resolveRemoteExecuteCode prefers invoke minting and rejects empty input', () => {
	assert.match(
		resolveRemoteExecuteCode({ invoke: '@scope/pkg#go' }),
		/kody:@scope\/pkg\/go/,
	)
	assert.equal(resolveRemoteExecuteCode({ code: 'export default () => 1' }), 'export default () => 1')
	assert.throws(() => resolveRemoteExecuteCode({}), /Provide --invoke, --code/)
	assert.throws(
		() => resolveRemoteExecuteCode({ code: 'a', invoke: 'kody:@x/y' }),
		/--invoke cannot be combined/,
	)
})

test('formatExecuteCapabilityResult maps ok/error envelopes', () => {
	const ok = formatExecuteCapabilityResult({
		ok: true,
		conversationId: 'c1',
		result: { hi: 1 },
		logs: [],
	})
	assert.equal(ok.isError, false)
	assert.match(ok.content[0]?.text ?? '', /"hi": 1/)
	const failed = formatExecuteCapabilityResult({
		ok: false,
		error: 'boom',
		logs: ['[error] boom'],
	})
	assert.equal(failed.isError, true)
	assert.equal(failed.content[0]?.text, 'Error: boom')
})

test('runRemoteExecuteWithToken opens a session then calls kody.execute', async () => {
	const calls: Array<{ method: string; url: string; body: unknown }> = []
	const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input)
		const body = init?.body ? JSON.parse(String(init.body)) : null
		calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url, body })
		if (url.endsWith('/v1/capability-proxy/session')) {
			return new Response(JSON.stringify({ scopes: ['local-execute'] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}
		return new Response(
			JSON.stringify({ result: { ok: true, result: { ran: true }, logs: [] } }),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)
	}) as typeof fetch

	const result = await runRemoteExecuteWithToken({
		code: 'export default async () => ({ ran: true })',
		params: { a: 1 },
		token: 'tok',
		apiUrl: 'https://api.kody.codes',
		fetchFn,
	})
	assert.equal(result.isError, false)
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), { ran: true })
	assert.equal(calls.length, 2)
	assert.match(calls[0]!.url, /\/v1\/capability-proxy\/session$/)
	assert.match(calls[1]!.url, /\/v1\/capability-proxy\/call$/)
	assert.deepEqual(calls[1]!.body, {
		path: ['kody', 'execute'],
		args: [{ code: 'export default async () => ({ ran: true })', params: { a: 1 } }],
	})
})

test('runRemoteExecuteWithToken surfaces missing-token session 401 clearly', async () => {
	const fetchFn = (async () =>
		new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }), {
			status: 401,
			headers: { 'content-type': 'application/json' },
		})) as typeof fetch
	await assert.rejects(
		() =>
			runRemoteExecuteWithToken({
				code: 'export default () => 1',
				token: 'bad',
				apiUrl: 'https://api.kody.codes',
				fetchFn,
			}),
		/--token or KODY_API_TOKEN/,
	)
})

test('runRemoteExecuteWithToken refuses to send the token over cleartext http', async () => {
	await assert.rejects(
		() =>
			runRemoteExecuteWithToken({
				code: 'export default () => 1',
				token: 'tok',
				apiUrl: 'http://api.example.com',
			}),
		/Refusing to send the API token|https/,
	)
})

test('runRemoteExecuteWithToken surfaces insufficient_scope on session', async () => {
	const fetchFn = (async () =>
		new Response(
			JSON.stringify({
				error: { code: 'insufficient_scope', message: 'need local-execute' },
			}),
			{ status: 403, headers: { 'content-type': 'application/json' } },
		)) as typeof fetch
	await assert.rejects(
		() =>
			runRemoteExecuteWithToken({
				code: 'export default () => 1',
				token: 'tok',
				apiUrl: 'https://api.kody.codes',
				fetchFn,
			}),
		/insufficient_scope[\s\S]*tokenCreate[\s\S]*local-execute/,
	)
})
