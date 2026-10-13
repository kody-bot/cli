import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	assertUserOwnedTokensLive,
	authSetupGit,
	decideSetupGitToken,
	ensureSetupGitScopes,
	gitCredentialHelperCommand,
	gitCredentialHostFromMcpUrl,
	installGitCredentialConfig,
	scopesIncludeRequired,
	setupGitDefaultScopes,
	setupGitRequiredScopes,
} from '../src/setup-git.js'
import { loadStoredApiToken } from '../src/api-token-store.js'
import { resolveCliTokenLifetime } from '../src/auth-bootstrap.js'
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

test('authSetupGit with login session and no API token mints then installs helper', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-setup-git-login-'))
	const tokenBackend = createFileBackend(join(home, 'api-token.json'))
	const mintedToken = `kody_at_${'m'.repeat(20)}_${'N'.repeat(43)}`
	const mintCalls: Array<Record<string, unknown>> = []
	const gitCalls: Array<Array<string>> = []
	const currentCalls: Array<string> = []

	const result = await authSetupGit({
		apiUrl: 'https://api.setup-git-login.test',
		mcpUrl: 'https://kody.codes/mcp',
		hasLoginSession: true,
		lifetime: resolveCliTokenLifetime({ lifetime: 'long' }),
		backend: tokenBackend,
		helperCommand: '!kody git-credential',
		runGit: (args) => {
			gitCalls.push([...args])
			return { status: 0, stderr: '' }
		},
		mint: async (params) => {
			mintCalls.push(params)
			return {
				bootstrap_code: `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`,
				scopes: setupGitDefaultScopes,
				idle_ttl_seconds: 1_209_600,
				max_lifetime_seconds: 7_776_000,
			}
		},
		fetchFn: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input)
			if (url.endsWith('/v1/tokens/bootstrap/redeem')) {
				return new Response(
					JSON.stringify({
						token: mintedToken,
						id: 'tok_login_mint',
						name: 'kody-cli-bootstrap',
						scopes: [...setupGitDefaultScopes],
						expires_at: '2026-11-01T00:00:00.000Z',
						max_expires_at: '2027-01-01T00:00:00.000Z',
						created_via: 'cli-bootstrap',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			if (url.includes('/v1/tokens/current')) {
				currentCalls.push(url)
				return new Response(
					JSON.stringify({
						id: 'tok_login_mint',
						org_binding: 'user',
						scopes: [...setupGitDefaultScopes],
						expires_at: '2026-11-01T00:00:00.000Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			return new Response(JSON.stringify({ error: { message: url } }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			})
		}) as typeof fetch,
	})

	assert.equal(result.minted, true)
	assert.equal(result.tokenId, 'tok_login_mint')
	assert.equal(result.orgBinding, 'user')
	assert.equal(mintCalls.length, 1)
	assert.deepEqual(mintCalls[0]?.lifetime, 'long')
	assert.ok(
		(mintCalls[0]?.scopes as Array<string>).includes('package:read') &&
			(mintCalls[0]?.scopes as Array<string>).includes('package:write'),
	)
	// Login OAuth cannot probe /tokens/current; only the minted token is checked.
	assert.equal(currentCalls.length, 1)
	assert.ok(currentCalls[0]?.includes('/v1/tokens/current'))
	assert.equal(gitCalls.length, 2)
	assert.equal(
		loadStoredApiToken('https://api.setup-git-login.test', tokenBackend)?.token,
		mintedToken,
	)
})

test('authSetupGit without login or API token fails with login guidance', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-setup-git-empty-'))
	await assert.rejects(
		() =>
			authSetupGit({
				apiUrl: 'https://api.setup-git-empty.test',
				mcpUrl: 'https://kody.codes/mcp',
				hasLoginSession: false,
				backend: createFileBackend(join(home, 'missing.json')),
				mint: async () => {
					throw new Error('mint should not run')
				},
				runGit: () => ({ status: 0, stderr: '' }),
			}),
		/Run `kody login`/,
	)
})
