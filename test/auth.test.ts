import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	credentialsFromTokens,
	isAccessTokenExpired,
	login,
} from '../src/auth.js'
import {
	cliClientMetadataUrl,
	cliRedirectUrl,
	defaultScopes,
	modernMcpProtocolVersion,
	scopeIncludesOpenid,
} from '../src/defaults.js'
import {
	buildCliClientMetadata,
	createCliOAuthProvider,
	orgSlugFromFlag,
} from '../src/oauth-provider.js'
import type { StoredCredentials } from '../src/store.js'

const previous: StoredCredentials = {
	version: 1,
	mcpUrl: 'https://kody.codes/mcp',
	resource: 'https://kody.codes/mcp',
	authorizationServerUrl: 'https://kody.codes',
	clientId: 'client-1',
	accessToken: 'old-access',
	refreshToken: 'old-refresh',
	tokenType: 'bearer',
	expiresAt: 1,
	scope: 'profile email',
}

test('defaultScopes request openid for login and CIMD metadata', () => {
	assert.deepEqual([...defaultScopes], ['openid', 'profile', 'email'])
	assert.equal(defaultScopes.join(' '), 'openid profile email')
	assert.equal(scopeIncludesOpenid('openid profile email'), true)
	assert.equal(scopeIncludesOpenid('profile email'), false)
	assert.equal(scopeIncludesOpenid(undefined), false)
})

test('isAccessTokenExpired uses a one-minute skew', () => {
	const now = 1_000_000
	assert.equal(
		isAccessTokenExpired({ ...previous, expiresAt: now + 30_000 }, now),
		true,
	)
	assert.equal(
		isAccessTokenExpired({ ...previous, expiresAt: now + 120_000 }, now),
		false,
	)
	assert.equal(
		isAccessTokenExpired({ ...previous, expiresAt: undefined }, now),
		false,
	)
})

test('credentialsFromTokens keeps the previous refresh token when omitted', () => {
	const next = credentialsFromTokens({
		mcpUrl: previous.mcpUrl,
		resource: previous.resource,
		authorizationServerUrl: previous.authorizationServerUrl,
		client: { client_id: 'client-1' },
		tokens: {
			access_token: 'new-access',
			token_type: 'bearer',
			expires_in: 3600,
		},
		previous,
		now: 5_000,
	})
	assert.equal(next.accessToken, 'new-access')
	assert.equal(next.refreshToken, 'old-refresh')
	assert.equal(next.expiresAt, 5_000 + 3600 * 1000)
})

test('credentialsFromTokens stores a rotated refresh token', () => {
	const next = credentialsFromTokens({
		mcpUrl: previous.mcpUrl,
		resource: previous.resource,
		authorizationServerUrl: previous.authorizationServerUrl,
		client: { client_id: 'client-1', client_secret: 'secret' },
		tokens: {
			access_token: 'new-access',
			refresh_token: 'rotated',
			token_type: 'bearer',
			expires_in: 10,
		},
		previous,
		now: 0,
	})
	assert.equal(next.refreshToken, 'rotated')
	assert.equal(next.clientSecret, 'secret')
	assert.equal(next.expiresAt, 10_000)
})

test('CLI OAuth identity is CIMD with a fixed loopback redirect', async () => {
	const mcpUrl = 'https://kody.codes/mcp'
	const metadata = buildCliClientMetadata()
	const provider = createCliOAuthProvider({
		mcpUrl,
		redirectUri: cliRedirectUrl(),
		loadStoredTokens: false,
		openBrowser: false,
		expectedState: 'state',
	})
	assert.equal(
		cliClientMetadataUrl(mcpUrl),
		'https://kody.codes/oauth/cli-client-metadata.json',
	)
	assert.equal(metadata.client_name, '@kodycodes/cli')
	assert.deepEqual(metadata.redirect_uris, [cliRedirectUrl().href])
	assert.equal(metadata.token_endpoint_auth_method, 'none')
	assert.equal(metadata.application_type, 'native')
	assert.equal(metadata.scope, 'openid profile email')
	assert.equal(modernMcpProtocolVersion, '2026-07-28')
	assert.equal(
		provider.clientMetadataUrl,
		'https://kody.codes/oauth/cli-client-metadata.json',
	)
	const client = await provider.clientInformation()
	assert.equal(client?.client_id, provider.clientMetadataUrl)
	assert.equal(provider.clientMetadata.scope, 'openid profile email')
})

test('orgSlugFromFlag lowercases and rejects a blank slug', () => {
	assert.equal(orgSlugFromFlag('Acme'), 'acme')
	assert.equal(orgSlugFromFlag('  KentCDodds  '), 'kentcdodds')
	assert.throws(() => orgSlugFromFlag('   '), /kody login --org acme/)
})

test('login authorize URL gets ?org= and keeps the canonical resource', async () => {
	const seen: Array<URL> = []
	const provider = createCliOAuthProvider({
		mcpUrl: 'https://kody.codes/mcp',
		redirectUri: cliRedirectUrl(),
		loadStoredTokens: false,
		openBrowser: false,
		expectedState: 'state',
		org: 'Acme',
		onAuthorizationUrl: (url) => {
			seen.push(new URL(url.href))
		},
	})
	const authorizationUrl = new URL(
		'https://kody.codes/oauth/authorize?response_type=code&resource=https%3A%2F%2Fkody.codes%2Fmcp&profile=CI+Bot',
	)
	await provider.redirectToAuthorization(authorizationUrl)
	assert.equal(seen.length, 1)
	const url = seen[0]
	assert.ok(url)
	assert.equal(url.searchParams.get('org'), 'acme')
	assert.equal(url.searchParams.get('profile'), 'CI Bot')
	assert.equal(url.searchParams.get('resource'), 'https://kody.codes/mcp')
	assert.equal(new URL(url.searchParams.get('resource') ?? '').search, '')
})

function oauthDiscoveryFetch(origin: string): typeof fetch {
	const metadata = {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/oauth/token`,
		response_types_supported: ['code'],
		code_challenge_methods_supported: ['S256'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: ['none'],
		client_id_metadata_document_supported: true,
	}
	const resource = {
		resource: `${origin}/mcp`,
		authorization_servers: [origin],
		scopes_supported: ['openid', 'profile', 'email'],
		bearer_methods_supported: ['header'],
	}
	return async (input) => {
		const url = new URL(
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url,
		)
		if (url.pathname.includes('oauth-protected-resource')) {
			return Response.json(resource)
		}
		if (
			url.pathname.includes('oauth-authorization-server') ||
			url.pathname.includes('openid-configuration')
		) {
			return Response.json(metadata)
		}
		return new Response('not found', { status: 404 })
	}
}

test('login appends ?org= on the authorize URL and omits it otherwise', async () => {
	const origin = 'https://oauth.test'
	const fetchFn = oauthDiscoveryFetch(origin)
	const withOrg: Array<URL> = []
	await assert.rejects(
		() =>
			login({
				mcpUrl: `${origin}/mcp`,
				org: 'Acme',
				openBrowser: false,
				timeoutMs: 200,
				fetchFn,
				onAuthorizationUrl: (url) => {
					withOrg.push(new URL(url.href))
				},
			}),
		/Timed out waiting for the browser login/,
	)
	assert.equal(withOrg.length, 1)
	const url = withOrg[0]
	assert.ok(url)
	assert.equal(url.origin + url.pathname, `${origin}/oauth/authorize`)
	assert.equal(url.searchParams.get('org'), 'acme')
	assert.equal(url.searchParams.get('resource'), `${origin}/mcp`)

	const withoutOrg: Array<URL> = []
	await assert.rejects(
		() =>
			login({
				mcpUrl: `${origin}/mcp`,
				openBrowser: false,
				timeoutMs: 200,
				fetchFn,
				onAuthorizationUrl: (url) => {
					withoutOrg.push(new URL(url.href))
				},
			}),
		/Timed out waiting for the browser login/,
	)
	assert.equal(withoutOrg.length, 1)
	assert.equal(withoutOrg[0]?.searchParams.get('org'), null)
	assert.equal(withoutOrg[0]?.searchParams.get('resource'), `${origin}/mcp`)
})

test('authorize URL omits org when the flag is absent', async () => {
	let seen: URL | undefined
	const provider = createCliOAuthProvider({
		mcpUrl: 'https://kody.codes/mcp',
		redirectUri: cliRedirectUrl(),
		loadStoredTokens: false,
		openBrowser: false,
		expectedState: 'state',
		onAuthorizationUrl: (url) => {
			seen = new URL(url.href)
		},
	})
	const authorizationUrl = new URL(
		'https://kody.codes/oauth/authorize?response_type=code&resource=https%3A%2F%2Fkody.codes%2Fmcp',
	)
	await provider.redirectToAuthorization(authorizationUrl)
	assert.equal(seen?.searchParams.get('org'), null)
	assert.equal(seen?.searchParams.get('resource'), 'https://kody.codes/mcp')
})
