import {
	Client,
	StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { cliName, modernMcpProtocolVersion } from './defaults.js'
import { readPackageVersion } from './package-info.js'
import { orgSlugFromFlag } from './oauth-provider.js'

/**
 * Resolve the org slug bound to an MCP OAuth access token via
 * `metaGetCurrentUser` (ADR 0064). Used after login and to finish silent
 * migration of legacy single-org credentials.
 */
export async function discoverOrgSlugFromAccessToken(input: {
	mcpUrl: string
	accessToken: string
	fetchFn?: typeof fetch
}): Promise<string> {
	const transport = new StreamableHTTPClientTransport(new URL(input.mcpUrl), {
		requestInit: {
			headers: {
				Authorization: `Bearer ${input.accessToken}`,
			},
		},
		...(input.fetchFn ? { fetch: input.fetchFn } : {}),
	})
	const client = new Client(
		{
			name: cliName,
			version: readPackageVersion(),
		},
		{ versionNegotiation: { mode: { pin: modernMcpProtocolVersion } } },
	)
	try {
		await client.connect(transport)
		const result = await client.callTool({
			name: 'api',
			arguments: { operationId: 'metaGetCurrentUser', params: {} },
		})
		const structured =
			result.structuredContent &&
			typeof result.structuredContent === 'object' &&
			!Array.isArray(result.structuredContent)
				? (result.structuredContent as Record<string, unknown>)
				: null
		if (result.isError) {
			const error =
				structured &&
				typeof structured.error === 'object' &&
				structured.error &&
				!Array.isArray(structured.error)
					? (structured.error as Record<string, unknown>)
					: null
			const message =
				error && typeof error.message === 'string'
					? error.message
					: 'metaGetCurrentUser failed'
			throw new Error(
				`Could not determine the organization for this login (${message}).`,
			)
		}
		const payload =
			structured && 'result' in structured ? structured.result : structured
		const org =
			payload &&
			typeof payload === 'object' &&
			!Array.isArray(payload) &&
			typeof (payload as { org?: { slug?: unknown } }).org?.slug === 'string'
				? (payload as { org: { slug: string } }).org.slug
				: null
		if (!org) {
			throw new Error(
				'Could not determine the organization for this login (metaGetCurrentUser returned no org.slug).',
			)
		}
		return orgSlugFromFlag(org)
	} finally {
		await transport.close().catch(() => undefined)
	}
}
