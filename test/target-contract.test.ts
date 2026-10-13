/**
 * One contract suite against both prod and the mock.
 *
 * - Always runs the mock leg in CI.
 * - Runs the prod leg when `KODY_CONTRACT_PROD=1` and a usable token/login exist
 *   (set in a trusted CI job with a scoped test token).
 *
 * Both legs assert the same operations from mock-supported.ts succeed, and that
 * an unsupported capability path fails clearly on the mock.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { callCapabilityProxy } from '../src/capability-proxy.js'
import { defaultApiUrl } from '../src/defaults.js'
import { mintMockApiToken, startMockServer } from '../src/mock/mock-server.js'
import { mockCapabilityPaths } from '../src/mock/mock-supported.js'
import { searchWithApiToken } from '../src/open-api-client.js'
import { resolveScopedApiToken } from '../src/api-token.js'

async function assertSharedContract(input: {
	label: string
	apiUrl: string
	token: string
}): Promise<void> {
	const session = await fetch(new URL('v1/capability-proxy/session', `${input.apiUrl}/`), {
		headers: { authorization: `Bearer ${input.token}` },
	})
	assert.equal(session.status, 200, `${input.label} session`)

	const me = await callCapabilityProxy({
		apiUrl: input.apiUrl,
		token: input.token,
		path: ['kody', 'metaGetCurrentUser'],
		args: [{}],
	})
	assert.ok(me && typeof me === 'object', `${input.label} metaGetCurrentUser`)

	const search = await searchWithApiToken({
		apiUrl: input.apiUrl,
		token: input.token,
		query: 'execute',
		limit: 5,
	})
	assert.equal(search.isError, false, `${input.label} search`)
}

test('contract: mock implements the shared capability subset', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-contract-mock-'))
	try {
		const server = await startMockServer({
			sessionId: 'contract',
			env: { KODY_CACHE_DIR: cache },
			resetStorage: true,
		})
		try {
			const token = mintMockApiToken(server.sessionId)
			await assertSharedContract({ label: 'mock', apiUrl: server.url, token })

			// Refuse unimplemented — never fake success.
			await assert.rejects(
				() =>
					callCapabilityProxy({
						apiUrl: server.url,
						token,
						path: ['kody', 'emailSend'],
						args: [{ to: 'x@example.com' }],
					}),
				/not_implemented_in_mock|501|emailSend/,
			)

			assert.ok(mockCapabilityPaths.includes('kody.metaGetCurrentUser'))
		} finally {
			await server.close()
		}
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test(
	'contract: prod implements the shared capability subset',
	{ skip: process.env.KODY_CONTRACT_PROD !== '1' },
	async () => {
		const token = resolveScopedApiToken({
			tokenValues: { token: process.env.KODY_API_TOKEN },
			env: process.env,
		})
		if (!token) {
			throw new Error('KODY_CONTRACT_PROD=1 requires KODY_API_TOKEN')
		}
		const apiUrl = process.env.KODY_API_URL || defaultApiUrl
		await assertSharedContract({ label: 'prod', apiUrl, token })
	},
)
