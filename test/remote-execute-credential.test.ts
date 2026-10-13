import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	credentialFlagRequiresLocalOrMcpMessage,
	runRemoteExecuteWithToken,
} from '../src/remote-execute.js'

test('runRemoteExecuteWithToken rejects --credential (map stays off kody.execute)', async () => {
	await assert.rejects(
		() =>
			runRemoteExecuteWithToken({
				code: 'export default () => 1',
				token: 'kody_at_x',
				apiUrl: 'https://api.kody.codes',
				credentials: { github: 'work' },
				fetchFn: (async () => {
					throw new Error('should not call the API')
				}) as typeof fetch,
			}),
		(error: Error) => {
			assert.equal(error.message, credentialFlagRequiresLocalOrMcpMessage)
			return true
		},
	)
})
