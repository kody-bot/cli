import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/cli.js'
import { buildUsage } from '../src/help.js'
import {
	formatStoredOrgsHelpBlock,
	orgEnvVar,
	resolveOrgSlug,
} from '../src/org.js'
import {
	createFileBackend,
	deleteCredentials,
	listStoredOrgs,
	loadCredentialStore,
	loadCredentials,
	migrateV1ToMultiOrg,
	parseCredentialStore,
	promotePendingOrg,
	saveCredentials,
	setActiveOrg,
	type StoredCredentials,
} from '../src/store.js'

const mcpUrl = 'https://multi-org.test/mcp'

function sample(
	overrides: Partial<StoredCredentials> = {},
): StoredCredentials {
	return {
		version: 1,
		mcpUrl,
		resource: mcpUrl,
		authorizationServerUrl: 'https://multi-org.test',
		clientId: 'client-1',
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		tokenType: 'bearer',
		expiresAt: Date.now() + 120_000,
		scope: 'openid profile email',
		...overrides,
	}
}

function tempBackend() {
	return createFileBackend(
		join(mkdtempSync(join(tmpdir(), 'kody-multi-org-')), 'credentials.json'),
	)
}

test('resolveOrgSlug prefers --org over KODY_ORG', () => {
	assert.equal(
		resolveOrgSlug({ flag: 'Acme', env: { [orgEnvVar]: 'other' } }),
		'acme',
	)
	assert.equal(resolveOrgSlug({ env: { [orgEnvVar]: 'Beta' } }), 'beta')
	assert.equal(resolveOrgSlug({ env: {} }), undefined)
})

test('v1 credentials migrate silently into a multi-org store as pending or named', () => {
	const pending = migrateV1ToMultiOrg(sample())
	assert.equal(pending.version, 2)
	assert.equal(pending.activeOrg, null)
	assert.ok(pending.pending)
	assert.deepEqual(Object.keys(pending.orgs), [])

	const named = migrateV1ToMultiOrg(sample({ org: 'Acme' }))
	assert.equal(named.activeOrg, 'acme')
	assert.equal(named.orgs.acme?.accessToken, 'access-1')
	assert.equal(named.pending, undefined)
})

test('parseCredentialStore upgrades on-disk v1 JSON without a re-login', () => {
	const raw = JSON.stringify(sample())
	const store = parseCredentialStore(raw, mcpUrl)
	assert.equal(store.version, 2)
	assert.ok(store.pending)
	assert.equal(store.activeOrg, null)

	const backend = tempBackend()
	backend.set(raw)
	const loaded = loadCredentials(mcpUrl, backend)
	assert.equal(loaded?.accessToken, 'access-1')
	assert.equal(loaded?.org, undefined)
})

test('login save upserts one org and keeps the other', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme', accessToken: 'a1' }), backend)
	saveCredentials(sample({ org: 'beta', accessToken: 'b1' }), backend)
	saveCredentials(sample({ org: 'acme', accessToken: 'a2' }), backend)

	const store = loadCredentialStore(mcpUrl, backend)
	assert.equal(store?.activeOrg, 'acme')
	assert.equal(store?.orgs.acme?.accessToken, 'a2')
	assert.equal(store?.orgs.beta?.accessToken, 'b1')
	assert.equal(loadCredentials(mcpUrl, backend)?.accessToken, 'a2')
	assert.equal(loadCredentials(mcpUrl, backend, undefined, { org: 'beta' })?.accessToken, 'b1')
})

test('setActiveOrg switches the default org', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme' }), backend)
	saveCredentials(sample({ org: 'beta' }), backend)
	setActiveOrg(mcpUrl, 'beta', backend)
	assert.equal(loadCredentials(mcpUrl, backend)?.org, 'beta')
	assert.deepEqual(listStoredOrgs(mcpUrl, backend), [
		{ slug: 'acme', active: false },
		{ slug: 'beta', active: true },
	])
})

test('logout without --org removes only the active org', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme' }), backend)
	saveCredentials(sample({ org: 'beta' }), backend)
	setActiveOrg(mcpUrl, 'acme', backend)
	const result = deleteCredentials(mcpUrl, backend)
	assert.equal(result.deleted, true)
	assert.equal(result.remaining, 1)
	const store = loadCredentialStore(mcpUrl, backend)
	assert.equal(store?.orgs.acme, undefined)
	assert.equal(store?.activeOrg, 'beta')
})

test('logout --org removes one org and keeps the rest', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme' }), backend)
	saveCredentials(sample({ org: 'beta' }), backend)
	const result = deleteCredentials(mcpUrl, backend, undefined, { org: 'acme' })
	assert.equal(result.deleted, true)
	assert.equal(result.remaining, 1)
	assert.equal(loadCredentialStore(mcpUrl, backend)?.orgs.beta?.org, 'beta')
})

test('promotePendingOrg finishes silent migration', () => {
	const backend = tempBackend()
	saveCredentials(sample(), backend)
	assert.ok(loadCredentialStore(mcpUrl, backend)?.pending)
	promotePendingOrg(mcpUrl, 'kentcdodds', backend)
	const store = loadCredentialStore(mcpUrl, backend)
	assert.equal(store?.pending, undefined)
	assert.equal(store?.activeOrg, 'kentcdodds')
	assert.equal(store?.orgs.kentcdodds?.accessToken, 'access-1')
})

test('help lists logged-in orgs from the local store offline', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme' }), backend)
	saveCredentials(sample({ org: 'beta' }), backend)
	setActiveOrg(mcpUrl, 'beta', backend)
	const text = buildUsage({
		mcpUrl,
		backend,
	})
	assert.match(text, /Logged-in orgs:/)
	assert.match(text, /\* beta\s+\(active\)/)
	assert.match(text, /  acme/)
	assert.match(text, /kody org list/)
	assert.match(text, /KODY_ORG/)
})

test('help hints kody login when nobody is logged in', () => {
	const block = formatStoredOrgsHelpBlock([])
	assert.match(block, /Not logged in\. Run `kody login`\./)
})

test('kody org list and org use work for agents', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'kody-org-cli-'))
	const previousXdg = process.env.XDG_CONFIG_HOME
	process.env.XDG_CONFIG_HOME = dir
	try {
		const { fileStorePath } = await import('../src/store.js')
		const backend = createFileBackend(fileStorePath(mcpUrl, dir))
		saveCredentials(sample({ org: 'acme', accessToken: 'a' }), backend)
		saveCredentials(sample({ org: 'beta', accessToken: 'b' }), backend)

		let stdout = ''
		const listCode = await runCli(['org', 'list', '--mcp-url', mcpUrl, '--json'], {
			stdout: (text) => {
				stdout += text
			},
		})
		assert.equal(listCode, 0, stdout)
		const parsed = JSON.parse(stdout) as {
			orgs: Array<{ slug: string; active: boolean }>
		}
		assert.deepEqual(
			parsed.orgs.map((row) => row.slug).sort(),
			['acme', 'beta'],
		)

		stdout = ''
		const useCode = await runCli(['org', 'use', 'acme', '--mcp-url', mcpUrl], {
			stdout: (text) => {
				stdout += text
			},
		})
		assert.equal(useCode, 0, stdout)
		assert.match(stdout, /Active org is now acme/)
		assert.equal(loadCredentials(mcpUrl, backend)?.org, 'acme')
	} finally {
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
	}
})

test('kody org use without a slug errors without a TTY', async () => {
	let stderr = ''
	const code = await runCli(['org', 'use'], {
		stderr: (text) => {
			stderr += text
		},
	})
	assert.equal(code, 1)
	assert.match(stderr, /requires a TTY|No named org logins|Not logged in|Usage: kody org/)
})

test('parseCredentials still derives a missing authorizationServerUrl (SEP-2352)', async () => {
	const { parseCredentials } = await import('../src/store.js')
	const parsed = parseCredentials(
		JSON.stringify({
			version: 1,
			mcpUrl: 'https://kody.codes/mcp',
			resource: 'https://kody.codes/mcp',
			clientId: 'client-1',
			accessToken: 'access',
			tokenType: 'bearer',
		}),
	)
	assert.equal(parsed.authorizationServerUrl, 'https://kody.codes')
})
