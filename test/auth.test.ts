import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	credentialsFromTokens,
	isAccessTokenExpired,
} from '../src/auth.js'
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
