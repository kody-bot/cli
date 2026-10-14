import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	commandAcceptsTarget,
	defaultTargetFor,
	parseTargetFlag,
	resolveTarget,
	targetEnvVar,
} from '../src/target.js'

test('defaultTargetFor: mock for dev, prod for execute/search/whoami', () => {
	assert.equal(defaultTargetFor('dev'), 'mock')
	assert.equal(defaultTargetFor('execute'), 'prod')
	assert.equal(defaultTargetFor('search'), 'prod')
	assert.equal(defaultTargetFor('whoami'), 'prod')
})

test('resolveTarget precedence: flag > env > default', () => {
	assert.equal(resolveTarget({ command: 'dev', env: {} }), 'mock')
	assert.equal(resolveTarget({ command: 'execute', env: {} }), 'prod')
	assert.equal(
		resolveTarget({ command: 'dev', env: { [targetEnvVar]: 'prod' } }),
		'prod',
	)
	assert.equal(
		resolveTarget({
			command: 'execute',
			flag: 'mock',
			env: { [targetEnvVar]: 'prod' },
		}),
		'mock',
	)
})

test('resolveTarget reads process.env.KODY_TARGET when env is omitted', () => {
	const previous = process.env[targetEnvVar]
	try {
		process.env[targetEnvVar] = 'mock'
		assert.equal(resolveTarget({ command: 'execute' }), 'mock')
		process.env[targetEnvVar] = 'prod'
		assert.equal(resolveTarget({ command: 'dev' }), 'prod')
	} finally {
		if (previous === undefined) delete process.env[targetEnvVar]
		else process.env[targetEnvVar] = previous
	}
})

test('parseTargetFlag rejects unknown values', () => {
	assert.equal(parseTargetFlag('PROD'), 'prod')
	assert.throws(() => parseTargetFlag('staging'), /prod.*or.*mock/)
})

test('commandAcceptsTarget', () => {
	assert.equal(commandAcceptsTarget('dev'), true)
	assert.equal(commandAcceptsTarget('execute'), true)
	assert.equal(commandAcceptsTarget('search'), true)
	assert.equal(commandAcceptsTarget('whoami'), true)
	assert.equal(commandAcceptsTarget('login'), false)
})
