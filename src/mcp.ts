import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { cliName } from './defaults.js'
import { ensureFreshCredentials, refreshStoredCredentials } from './auth.js'
import { readPackageVersion } from './package-info.js'
import { redactError } from './redact.js'
import type { SecretBackend } from './store.js'

export type CallToolInput = {
	name: 'search' | 'execute'
	args: Record<string, unknown>
	mcpUrl?: string
	backend?: SecretBackend
	fetchFn?: typeof fetch
}

export type ToolCallResult = {
	content: Array<{ type: string; text?: string; [key: string]: unknown }>
	structuredContent?: unknown
	isError?: boolean
}

function requestMethod(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) {
	if (init?.method) return init.method.toUpperCase()
	if (typeof Request !== 'undefined' && input instanceof Request) {
		return input.method.toUpperCase()
	}
	return 'GET'
}

/**
 * Streamable HTTP clients open an optional GET SSE after initialize. Kody's
 * sessionful `/mcp` GET holds that session until the stream ends, so the
 * follow-up POST (`tools/list`, `search`, `execute`) never completes. The
 * spec treats GET SSE as optional; 405 tells the SDK to stay on POST.
 */
export function createMcpFetch(fetchFn: typeof fetch = fetch): typeof fetch {
	return (input, init) => {
		if (requestMethod(input, init) === 'GET') {
			return Promise.resolve(
				new Response('Method Not Allowed', { status: 405 }),
			)
		}
		return fetchFn(input, init)
	}
}

async function connect(
	mcpUrl: string,
	accessToken: string,
	fetchFn?: typeof fetch,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
	const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
		requestInit: {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
		fetch: createMcpFetch(fetchFn ?? fetch),
	})
	const client = new Client({
		name: cliName,
		version: readPackageVersion(),
	})
	await client.connect(transport)
	return { client, transport }
}

export async function callKodyTool(
	input: CallToolInput,
): Promise<ToolCallResult> {
	const credentials = await ensureFreshCredentials({
		mcpUrl: input.mcpUrl,
		backend: input.backend,
		fetchFn: input.fetchFn,
	})
	try {
		return await invoke(credentials.mcpUrl, credentials.accessToken, input)
	} catch (error) {
		if (!(error instanceof UnauthorizedError) && !isUnauthorized(error)) {
			throw redactError(error)
		}
		const refreshed = await refreshStoredCredentials({
			credentials,
			backend: input.backend,
			fetchFn: input.fetchFn,
		})
		try {
			return await invoke(refreshed.mcpUrl, refreshed.accessToken, input)
		} catch (retryError) {
			throw redactError(retryError)
		}
	}
}

async function invoke(
	mcpUrl: string,
	accessToken: string,
	input: CallToolInput,
): Promise<ToolCallResult> {
	const { client, transport } = await connect(mcpUrl, accessToken, input.fetchFn)
	try {
		const result = await client.callTool({
			name: input.name,
			arguments: input.args,
		})
		return result as ToolCallResult
	} finally {
		await transport.close().catch(() => undefined)
	}
}

export async function listKodyTools(input: {
	mcpUrl?: string
	backend?: SecretBackend
	fetchFn?: typeof fetch
}): Promise<Array<{ name: string; description?: string }>> {
	const credentials = await ensureFreshCredentials({
		mcpUrl: input.mcpUrl,
		backend: input.backend,
		fetchFn: input.fetchFn,
	})
	const { client, transport } = await connect(
		credentials.mcpUrl,
		credentials.accessToken,
		input.fetchFn,
	)
	try {
		const listed = await client.listTools()
		return listed.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
		}))
	} finally {
		await transport.close().catch(() => undefined)
	}
}

export function formatToolResult(
	result: ToolCallResult,
	json: boolean,
): string {
	if (json) {
		return `${JSON.stringify(
			{
				isError: result.isError ?? false,
				structuredContent: result.structuredContent ?? null,
				content: result.content,
			},
			null,
			2,
		)}\n`
	}
	const texts = result.content
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text ?? '')
	if (texts.length > 0) return texts.join('\n\n').replace(/\n*$/, '\n')
	if (result.structuredContent != null) {
		return `${JSON.stringify(result.structuredContent, null, 2)}\n`
	}
	return `${JSON.stringify(result.content, null, 2)}\n`
}

function isUnauthorized(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false
	const status = 'code' in error ? error.code : undefined
	return status === 401 || (error instanceof Error && /401|unauthorized/i.test(error.message))
}
