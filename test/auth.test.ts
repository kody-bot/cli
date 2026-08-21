import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	credentialsFromTokens,
	isAccessTokenExpired,
} from '../src/auth.js'
import {
	cliClientMetadataUrl,
	cliRedirectUrl,
	modernMcpProtocolVersion,
} from '../src/defaults.js'
import {
	buildCliClientMetadata,
	createCliOAuthProvider,
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
	assert.equal(modernMcpProtocolVersion, '2026-07-28')
	assert.equal(
		provider.clientMetadataUrl,
		'https://kody.codes/oauth/cli-client-metadata.json',
	)
	const client = await provider.clientInformation()
	assert.equal(client?.client_id, provider.clientMetadataUrl)
})
