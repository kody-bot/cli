import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	accountForMcpUrl,
	createFileBackend,
	fileStorePath,
	parseCredentials,
	saveCredentials,
	loadCredentials,
	deleteCredentials,
	type StoredCredentials,
} from '../src/store.js'

const sample: StoredCredentials = {
	version: 1,
	mcpUrl: 'https://kody.codes/mcp',
	resource: 'https://kody.codes/mcp',
	authorizationServerUrl: 'https://kody.codes',
	clientId: 'client-1',
	accessToken: 'access-1',
	refreshToken: 'refresh-1',
	tokenType: 'bearer',
	expiresAt: Date.now() + 60_000,
	scope: 'profile email',
}

test('accountForMcpUrl is origin-scoped', () => {
	assert.equal(accountForMcpUrl('https://kody.codes/mcp'), 'cli:https://kody.codes')
	assert.equal(
		accountForMcpUrl('https://preview.kody.codes/mcp'),
		'cli:https://preview.kody.codes',
	)
})

test('fileStorePath uses XDG on linux-like homes', () => {
	const path = fileStorePath('https://kody.codes/mcp', '/tmp/home')
	assert.match(path, /credentials-kody\.codes\.json$/)
})

test('file backend stores, loads, and deletes credentials', () => {
	const dir = mkdtempSync(join(tmpdir(), 'kody-cli-'))
	const backend = createFileBackend(join(dir, 'credentials.json'))
	saveCredentials(sample, backend)
	const loaded = loadCredentials(sample.mcpUrl, backend)
	assert.deepEqual(loaded, sample)
	if (process.platform !== 'win32' && backend.path) {
		chmodSync(backend.path, 0o600)
		assert.equal(statSync(backend.path).mode & 0o777, 0o600)
	}
	assert.equal(deleteCredentials(sample.mcpUrl, backend).deleted, true)
	assert.equal(loadCredentials(sample.mcpUrl, backend), null)
})

test('parseCredentials rejects invalid payloads', () => {
	assert.throws(() => parseCredentials('{}'), /invalid/i)
	assert.throws(() => parseCredentials('{"version":2}'), /invalid/i)
})
