export const defaultMcpUrl = 'https://kody.codes/mcp'
/** Pin to Kody's stateless `/mcp` lane. */
export const modernMcpProtocolVersion = '2026-07-28'
export const defaultScopes = ['profile', 'email'] as const
export const keyringService = 'kody.codes'
export const loginTimeoutMs = 5 * 60 * 1000
export const accessTokenSkewMs = 60_000
export const cliName = '@kodycodes/cli'
export const cliClientUri = 'https://github.com/kody-bot/cli'
/** Fixed loopback port so CIMD can list an exact redirect URI. */
export const oauthCallbackPort = 43742
export const cliClientIdMetadataPath = '/oauth/cli-client-metadata.json'

export function cliClientMetadataUrl(mcpUrl: string): string {
	return new URL(cliClientIdMetadataPath, mcpUrl).href
}

export function cliRedirectUrl(port: number = oauthCallbackPort): URL {
	return new URL(`http://127.0.0.1:${port}/callback`)
}
