import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	missingCredentialCallMapFeatureMessage,
	parseCredentialFlag,
	parseCredentialFlags,
	sessionSupportsCredentialCallMap,
} from '../src/credential-call-map.js'
import { buildExecuteToolArgs, resolveCommand } from '../src/cli.js'
import { credentialFlagRequiresLocalOrMcpMessage } from '../src/remote-execute.js'

test('parseCredentialFlag accepts name, scoped name, and empty none', () => {
	assert.deepEqual(parseCredentialFlag('github=work'), {
		key: 'github',
		picks: ['work'],
	})
	assert.deepEqual(parseCredentialFlag('x=org:work'), {
		key: 'x',
		picks: [{ name: 'work', scope: 'org' }],
	})
	assert.deepEqual(parseCredentialFlag('x=personal:home'), {
		key: 'x',
		picks: [{ name: 'home', scope: 'personal' }],
	})
	assert.deepEqual(parseCredentialFlag('github='), { key: 'github', picks: [] })
})

test('parseCredentialFlags merges repeated keys into arrays', () => {
	assert.deepEqual(
		parseCredentialFlags(['github=work', 'google=org:corp', 'github=personal:home']),
		{
			github: ['work', { name: 'home', scope: 'personal' }],
			google: { name: 'corp', scope: 'org' },
		},
	)
	assert.equal(parseCredentialFlags(undefined), undefined)
	assert.equal(parseCredentialFlags([]), undefined)
})

test('parseCredentialFlag rejects bad shapes', () => {
	assert.throws(() => parseCredentialFlag('=work'), /Invalid --credential/)
	assert.throws(() => parseCredentialFlag('github'), /Invalid --credential/)
	assert.throws(() => parseCredentialFlag(' github=work'), /Invalid --credential key/)
	assert.throws(() => parseCredentialFlag('github= work'), /Leading or trailing spaces/)
})

test('resolveCommand collects multiple --credential flags', () => {
	const { values } = resolveCommand([
		'execute',
		'--local',
		'--credential',
		'github=work',
		'--credential',
		'x=org:work',
		'--code',
		'export default () => 1',
	])
	assert.deepEqual(values.credential, ['github=work', 'x=org:work'])
})

test('buildExecuteToolArgs attaches credentials for MCP execute', () => {
	assert.deepEqual(
		buildExecuteToolArgs({
			code: 'export default () => 1',
			credentials: { github: 'work' },
		}),
		{ code: 'export default () => 1', credentials: { github: 'work' } },
	)
})

test('sessionSupportsCredentialCallMap reads the feature flag', () => {
	assert.equal(sessionSupportsCredentialCallMap(['credential-call-map']), true)
	assert.equal(sessionSupportsCredentialCallMap(['other']), false)
	assert.equal(sessionSupportsCredentialCallMap(undefined), false)
	assert.match(
		missingCredentialCallMapFeatureMessage('https://api.kody.codes'),
		/credential-call-map/,
	)
	assert.match(credentialFlagRequiresLocalOrMcpMessage, /--local/)
})
