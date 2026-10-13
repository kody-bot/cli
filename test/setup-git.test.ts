import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	assertUserOwnedTokensLive,
	decideSetupGitToken,
	ensureSetupGitScopes,
	gitCredentialHelperCommand,
	gitCredentialHostFromMcpUrl,
	installGitCredentialConfig,
	scopesIncludeRequired,
	setupGitDefaultScopes,
	setupGitRequiredScopes,
} from '../src/setup-git.js'
import {
	formatGitCredentialOutput,
	isKodyGitHttpsHost,
	parseGitCredentialAction,
	parseGitCredentialInput,
	handleGitCredential,
} from '../src/git-credential.js'
import type { StoredApiToken } from '../src/api-token-store.js'
import { resolveCommand } from '../src/cli.js'
import { createFileBackend } from '../src/store.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sampleStored = (scopes: Array<string>): StoredApiToken => ({
	version: 1,
	apiUrl: 'https://api.kody.codes',
	token: `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`,
	tokenId: 'tok_1',
	scopes,
	createdVia: 'cli-bootstrap',
})

test('resolveCommand maps auth setup-git and git-credential', () => {
	assert.equal(resolveCommand(['auth', 'setup-git']).command, 'auth')
	assert.equal(resolveCommand(['auth', 'setup-git']).positionals[0], 'setup-git')
	assert.equal(resolveCommand(['git-credential', 'get']).command, 'git-credential')
	assert.equal(resolveCommand(['git-credential', 'get']).positionals[0], 'get')
})

test('gitCredentialHostFromMcpUrl uses the MCP origin host', () => {
	assert.equal(gitCredentialHostFromMcpUrl('https://kody.codes/mcp'), 'kody.codes')
	assert.equal(
		gitCredentialHostFromMcpUrl('https://kody-pr-3572.kody-a99.workers.dev/mcp'),
		'kody-pr-3572.kody-a99.workers.dev',
	)
})

test('scopesIncludeRequired and ensureSetupGitScopes', () => {
	assert.equal(scopesIncludeRequired(['package:read', 'package:write']), true)
	assert.equal(scopesIncludeRequired(['package:read']), false)
	assert.deepEqual(
		ensureSetupGitScopes(['org:read']),
		['org:read', 'package:read', 'package:write'],
	)
	for (const scope of setupGitRequiredScopes) {
		assert.ok(setupGitDefaultScopes.includes(scope))
	}
})

test('assertUserOwnedTokensLive rejects missing org_binding', () => {
	assert.throws(
		() =>
			assertUserOwnedTokensLive({
				id: 't',
				orgBinding: null,
				scopes: [...setupGitRequiredScopes],
				expiresAt: null,
			}),
		/org_binding/,
	)
	assert.doesNotThrow(() =>
		assertUserOwnedTokensLive({
			id: 't',
			orgBinding: 'user',
			scopes: [...setupGitRequiredScopes],
			expiresAt: null,
		}),
	)
})

test('decideSetupGitToken reuses a suitable user-owned token', () => {
	const stored = sampleStored(['package:read', 'package:write', 'org:execute'])
	const decision = decideSetupGitToken({
		stored,
		metadata: {
			id: stored.tokenId,
			orgBinding: 'user',
			scopes: stored.scopes!,
			expiresAt: null,
		},
	})
	assert.equal(decision.action, 'reuse')
})

test('decideSetupGitToken mints when package scopes are missing', () => {
	const stored = sampleStored(['org:execute', 'org:read'])
	const decision = decideSetupGitToken({
		stored,
		metadata: {
			id: stored.tokenId,
			orgBinding: 'user',
			scopes: stored.scopes!,
			expiresAt: null,
		},
	})
	assert.equal(decision.action, 'mint')
	if (decision.action === 'mint') {
		assert.ok(decision.scopes.includes('package:read'))
		assert.ok(decision.scopes.includes('package:write'))
		assert.ok(decision.scopes.includes('org:execute'))
		assert.equal(decision.lifetime.kind, 'alias')
		if (decision.lifetime.kind === 'alias') {
			assert.equal(decision.lifetime.lifetime, 'long')
		}
	}
})

test('installGitCredentialConfig writes helper + useHttpPath', () => {
	const calls: Array<Array<string>> = []
	const installed = installGitCredentialConfig({
		host: 'kody.codes',
		helperCommand: '!kody git-credential',
		runGit: (args) => {
			calls.push([...args])
			return { status: 0, stderr: '' }
		},
	})
	assert.equal(installed.scope, '--global')
	assert.deepEqual(calls, [
		[
			'config',
			'--global',
			'credential.https://kody.codes.helper',
			'!kody git-credential',
		],
		['config', '--global', 'credential.https://kody.codes.useHttpPath', 'true'],
	])
})

test('gitCredentialHelperCommand quotes the running entry', () => {
	const cmd = gitCredentialHelperCommand({
		execPath: '/usr/bin/node',
		entryPath: '/tmp/kody-bot-cli/dist/bin.js',
	})
	assert.equal(cmd, '!/usr/bin/node /tmp/kody-bot-cli/dist/bin.js git-credential')
})

test('parseGitCredentialInput and get output', async () => {
	const req = parseGitCredentialInput(
		'protocol=https\nhost=kody.codes\npath=@kent/pkg.git\n\n',
	)
	assert.deepEqual(req, {
		protocol: 'https',
		host: 'kody.codes',
		path: '@kent/pkg.git',
	})
	assert.equal(parseGitCredentialAction(['get']), 'get')
	assert.throws(() => parseGitCredentialAction([]), /Usage/)
	assert.equal(
		formatGitCredentialOutput({ username: 'x', password: 'kody_at_abc' }),
		'username=x\npassword=kody_at_abc\n',
	)
	assert.equal(
		isKodyGitHttpsHost({
			protocol: 'https',
			host: 'kody.codes',
			expectedHost: 'kody.codes',
		}),
		true,
	)
	assert.equal(
		isKodyGitHttpsHost({
			protocol: 'https',
			host: 'github.com',
			expectedHost: 'kody.codes',
		}),
		false,
	)

	const emptyDir = mkdtempSync(join(tmpdir(), 'kody-git-cred-'))
	const emptyBackend = createFileBackend(join(emptyDir, 'empty-token.json'))
	const empty = await handleGitCredential({
		action: 'get',
		request: { protocol: 'https', host: 'github.com' },
		apiUrl: 'https://api.example.test',
		mcpUrl: 'https://kody.codes/mcp',
		backend: emptyBackend,
	})
	assert.equal(empty, '')

	const tokenPath = join(emptyDir, 'token.json')
	const stored = sampleStored(['package:read', 'package:write'])
	writeFileSync(tokenPath, JSON.stringify(stored))
	const filled = await handleGitCredential({
		action: 'get',
		request: { protocol: 'https', host: 'kody.codes', path: '@a/b.git' },
		apiUrl: stored.apiUrl,
		mcpUrl: 'https://kody.codes/mcp',
		backend: createFileBackend(tokenPath),
	})
	assert.equal(filled, formatGitCredentialOutput({ username: 'x', password: stored.token }))
})
