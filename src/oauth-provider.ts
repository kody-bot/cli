import {
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
	validateClientMetadataUrl,
} from '@modelcontextprotocol/client'
import {
	cliClientMetadataUrl,
	cliClientUri,
	cliName,
	cliRedirectUrl,
	defaultScopes,
} from './defaults.js'
import type { StoredCredentials } from './store.js'
import { openUrl } from './open-url.js'

export function buildCliClientMetadata(): OAuthClientMetadata {
	return {
		client_name: cliName,
		client_uri: cliClientUri,
		redirect_uris: [cliRedirectUrl().href],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'native',
		scope: defaultScopes.join(' '),
	}
}

/** Public org slug: trim and lowercase, matching the server's `?org=` rules. */
export function orgSlugFromFlag(value: string): string {
	const slug = value.trim().toLowerCase()
	if (!slug) {
		throw new Error(
			'`--org` requires an organization slug. Example: `kody login --org acme`.',
		)
	}
	return slug
}

export function createCliOAuthProvider(input: {
	mcpUrl: string
	redirectUri: URL
	existing?: StoredCredentials
	loadStoredTokens: boolean
	openBrowser: boolean
	expectedState: string
	/**
	 * Bind the grant to this org. Set on the authorize URL (`?org=`).
	 * Do not put it on the OAuth `resource`: production rejects a resource
	 * that adds a query (`?org=` or `?profile=`).
	 */
	org?: string
	onAuthorizationUrl?: (url: URL) => void
}): OAuthClientProvider {
	const clientMetadataUrl = cliClientMetadataUrl(input.mcpUrl)
	validateClientMetadataUrl(clientMetadataUrl)
	let codeVerifier = ''
	let discoveryState: OAuthDiscoveryState | undefined
	// Always present a CIMD client_id. Leaving this empty would let the SDK
	// fall back to deprecated dynamic client registration.
	let clientInformation: StoredOAuthClientInformation | undefined =
		input.existing
			? {
					client_id: input.existing.clientId,
					...(input.existing.clientSecret
						? { client_secret: input.existing.clientSecret }
						: {}),
					issuer: input.existing.authorizationServerUrl,
				}
			: { client_id: clientMetadataUrl }
	let tokens: StoredOAuthTokens | undefined =
		input.loadStoredTokens && input.existing
			? {
					access_token: input.existing.accessToken,
					token_type: input.existing.tokenType,
					...(input.existing.refreshToken
						? { refresh_token: input.existing.refreshToken }
						: {}),
					...(input.existing.scope ? { scope: input.existing.scope } : {}),
					issuer: input.existing.authorizationServerUrl,
				}
			: undefined

	return {
		clientMetadataUrl,
		get redirectUrl() {
			return input.redirectUri
		},
		get clientMetadata() {
			return buildCliClientMetadata()
		},
		state() {
			return input.expectedState
		},
		clientInformation() {
			return clientInformation
		},
		saveClientInformation(next) {
			clientInformation = next
		},
		tokens() {
			return tokens
		},
		saveTokens(next) {
			tokens = next
		},
		async redirectToAuthorization(authorizationUrl) {
			if (input.org !== undefined) {
				authorizationUrl.searchParams.set('org', orgSlugFromFlag(input.org))
			}
			input.onAuthorizationUrl?.(authorizationUrl)
			if (input.openBrowser) {
				await openUrl(authorizationUrl.href)
			}
		},
		saveCodeVerifier(next) {
			codeVerifier = next
		},
		codeVerifier() {
			if (!codeVerifier) {
				throw new Error('OAuth PKCE verifier is missing.')
			}
			return codeVerifier
		},
		saveDiscoveryState(next) {
			discoveryState = next
		},
		discoveryState() {
			return discoveryState
		},
	}
}
