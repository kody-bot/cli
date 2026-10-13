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

/** SEP-2352 issuer stamp restored from durable CLI storage. */
export function issuerFromStoredCredentials(
	credentials: StoredCredentials,
): string {
	const recorded = credentials.authorizationServerUrl?.trim()
	if (recorded) return recorded
	return new URL(credentials.mcpUrl).origin
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
	// Leave clientInformation unset on a fresh login. Seeding `{ client_id }`
	// without an `issuer` stamp makes auth() warn (SEP-2352) on the first
	// read. With `clientMetadataUrl` set, the SDK writes
	// `{ client_id: clientMetadataUrl, issuer }` when the AS advertises CIMD.
	// When reloading stored credentials, stamp `issuer` from durable storage
	// so SEP-2352 isolation stays active without a relogin.
	let clientInformation: StoredOAuthClientInformation | undefined =
		input.existing
			? {
					client_id: input.existing.clientId,
					...(input.existing.clientSecret
						? { client_secret: input.existing.clientSecret }
						: {}),
					issuer: issuerFromStoredCredentials(input.existing),
				}
			: undefined
	let tokens: StoredOAuthTokens | undefined =
		input.loadStoredTokens && input.existing
			? {
					access_token: input.existing.accessToken,
					token_type: input.existing.tokenType,
					...(input.existing.refreshToken
						? { refresh_token: input.existing.refreshToken }
						: {}),
					...(input.existing.scope ? { scope: input.existing.scope } : {}),
					issuer: issuerFromStoredCredentials(input.existing),
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
			// Round-trip the SEP-2352 `issuer` stamp verbatim.
			clientInformation = next
		},
		tokens() {
			return tokens
		},
		saveTokens(next) {
			// Round-trip the SEP-2352 `issuer` stamp verbatim.
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
