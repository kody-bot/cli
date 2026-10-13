import {
	Client,
	StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { cliName, modernMcpProtocolVersion } from './defaults.js'
import type { LoginCallbackAccount } from './login-callback-page.js'
import { orgSlugFromFlag } from './oauth-provider.js'
import { readPackageVersion } from './package-info.js'

export type LoginIdentity = {
	org: string
	account: LoginCallbackAccount
}

/**
 * Resolve org + harmless account fields for the just-minted MCP OAuth access
 * token via `metaGetCurrentUser` (ADR 0064).
 *
 * Coordinates with multi-org login (kody-bot/cli#42): that change stores the
 * org slug; this callback page needs the same read (plus account) before it
 * can render the success state.
 */
export async function discoverLoginIdentity(input: {
	mcpUrl: string
	accessToken: string
	fetchFn?: typeof fetch
}): Promise<LoginIdentity> {
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
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			throw new Error(
				'Could not determine the organization for this login (metaGetCurrentUser returned no result).',
			)
		}
		const record = payload as {
			org?: { slug?: unknown }
			email?: unknown
			display_name?: unknown
			username?: unknown
		}
		const orgSlug =
			typeof record.org?.slug === 'string' ? record.org.slug : null
		if (!orgSlug) {
			throw new Error(
				'Could not determine the organization for this login (metaGetCurrentUser returned no org.slug).',
			)
		}
		const account: LoginCallbackAccount = {}
		if (typeof record.display_name === 'string' && record.display_name.trim()) {
			account.displayName = record.display_name.trim()
		}
		if (typeof record.email === 'string' && record.email.trim()) {
			account.email = record.email.trim()
		}
		if (typeof record.username === 'string' && record.username.trim()) {
			account.username = record.username.trim()
		}
		return {
			org: orgSlugFromFlag(orgSlug),
			account,
		}
	} finally {
		await transport.close().catch(() => undefined)
	}
}
