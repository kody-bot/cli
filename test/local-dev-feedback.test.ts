/**
 * Local-dev tooling feedback: unmocked_request self-discovery, local
 * --invoke kody:@…, dev check mocks suggestion, fail-closed help.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	detectCredentialedFetchInSource,
	mocksSuggestionDetail,
} from '../src/credentialed-fetch-scan.js'
import { runDevCheck } from '../src/dev-command.js'
import { buildUsage } from '../src/help.js'
import { resolveExecuteInvokeCode } from '../src/invoke-passthrough.js'
import {
	buildHandlerLine,
	buildHandlerStub,
	unmockedRequestError,
} from '../src/mock/mock-fetch-gateway.js'

test('unmocked_request includes ready-to-paste stub + .kody/mocks.ts pointer', () => {
	const error = unmockedRequestError('POST', 'https://api.example.com/v1/items')
	assert.equal(error.code, 'unmocked_request')
	assert.match(error.fix ?? '', /\.kody\/mocks\.ts/)
	assert.match(error.fix ?? '', /Ready-to-paste/)
	assert.match(error.fix ?? '', /http\.post/)
	assert.match(error.fix ?? '', /append this handler/)
	assert.equal(error.details?.mocksPath, '.kody/mocks.ts')
	assert.match(String(error.details?.handlerStub ?? ''), /export const handlers/)
	assert.match(String(error.details?.handlerLine ?? ''), /http\.post/)
	const stub = buildHandlerStub('GET', 'https://api.example.com/x')
	const line = buildHandlerLine('GET', 'https://api.example.com/x')
	assert.match(stub, /import \{ http, HttpResponse \} from 'msw'/)
	assert.match(line, /http\.get\("https:\/\/api\.example\.com\/x"/)
})

test('--invoke kody:@… mints the same thin passthrough as a --code wrapper', () => {
	const code = resolveExecuteInvokeCode('kody:@scope/pkg/export')
	assert.match(code, /import action from "kody:@scope\/pkg\/export"/)
	assert.match(code, /return await action\(params\)/)
	assert.equal(
		resolveExecuteInvokeCode('@scope/pkg#export'),
		resolveExecuteInvokeCode('kody:@scope/pkg/export'),
	)
})

test('detectCredentialedFetchInSource finds createAuthenticatedFetch and credential imports', async () => {
	const auth = await detectCredentialedFetchInSource(
		`import { createAuthenticatedFetch } from 'kody:runtime'
export default async () => createAuthenticatedFetch('github')
`,
		'export:./x',
	)
	assert.ok(auth.some((s) => s.kind === 'createAuthenticatedFetch'))

	const cred = await detectCredentialedFetchInSource(
		`import { credential } from 'kody:runtime'
export default async () => (await credential('github')).name
`,
		'export:./y',
	)
	assert.ok(cred.some((s) => s.kind === 'credential_runtime'))

	const docsOnly = await detectCredentialedFetchInSource(
		`/**
 * Example: import { credential } from 'kody:runtime'
 * createAuthenticatedFetch('github')
 */
export default async () => ({ ok: true })
`,
	)
	assert.deepEqual(docsOnly, [])
})

test('mocksSuggestionDetail soft-suggests when credentialed fetch lacks mocks.ts', () => {
	assert.equal(
		mocksSuggestionDetail({ signals: [], hasMocksFile: false }),
		null,
	)
	const tip = mocksSuggestionDetail({
		signals: [{ kind: 'createAuthenticatedFetch', where: 'export:./x' }],
		hasMocksFile: false,
	})
	assert.match(tip ?? '', /suggested/)
	assert.match(tip ?? '', /\.kody\/mocks\.ts/)
	const present = mocksSuggestionDetail({
		signals: [{ kind: 'createAuthenticatedFetch', where: 'export:./x' }],
		hasMocksFile: true,
	})
	assert.match(present ?? '', /present/)
})

test('kody dev check suggests .kody/mocks.ts when package uses createAuthenticatedFetch', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-check-mocks-'))
	try {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@local/cred-fetch',
				type: 'module',
				exports: { './fetch': './src/fetch.ts' },
				kody: { id: 'cred-fetch' },
			}),
		)
		await writeFile(join(root, 'README.md'), '# cred-fetch\n')
		await writeFile(join(root, 'AGENTS.md'), '# Agents\n')
		await mkdir(join(root, 'src'), { recursive: true })
		await writeFile(
			join(root, 'src/fetch.ts'),
			`import { createAuthenticatedFetch } from 'kody:runtime'
export default async function main() {
	const fetchFn = await createAuthenticatedFetch('github')
	return fetchFn('https://api.github.com/user')
}
`,
		)

		let stdout = ''
		const code = await runDevCheck({
			target: 'mock',
			cwd: root,
			json: true,
			io: {
				stdout: (text) => {
					stdout += text
				},
				stderr: () => {},
			},
		})
		assert.equal(code, 0)
		const parsed = JSON.parse(stdout) as {
			ok: boolean
			checks: Array<{ name: string; detail?: string }>
			credentialedFetch?: { detected: boolean; hasMocksFile: boolean }
		}
		assert.equal(parsed.ok, true)
		assert.equal(parsed.credentialedFetch?.detected, true)
		assert.equal(parsed.credentialedFetch?.hasMocksFile, false)
		const mocksCheck = parsed.checks.find((c) => c.name === '.kody/mocks.ts')
		assert.ok(mocksCheck)
		assert.match(mocksCheck.detail ?? '', /suggested/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('help documents local --invoke kody:@ and fail-closed mocks (not native workerd fetch)', () => {
	const text = buildUsage()
	assert.match(text, /--invoke kody:@scope\/pkg\/export/)
	assert.match(text, /soft-suggests/)
	assert.match(text, /ready-to-paste MSW handler stub/)
	assert.doesNotMatch(text, /keep native workerd fetch/)
	assert.match(text, /fail closed|fail-closed/i)
})
