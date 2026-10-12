import {
	Client,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from '@modelcontextprotocol/client'
import {
	cliName,
	missingOpenidReloginHint,
	modernMcpProtocolVersion,
	scopeIncludesOpenid,
} from './defaults.js'
import { ensureFreshCredentials, refreshStoredCredentials } from './auth.js'
import { readPackageVersion } from './package-info.js'
import { redactError } from './redact.js'
import type { SecretBackend } from './store.js'

export type CallToolInput = {
	name: 'search' | 'execute' | 'api'
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
		...(fetchFn ? { fetch: fetchFn } : {}),
	})
	const client = new Client(
		{
			name: cliName,
			version: readPackageVersion(),
		},
		{ versionNegotiation: { mode: { pin: modernMcpProtocolVersion } } },
	)
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
			throw withOpenidScopeHint(error, credentials.scope)
		}
		const refreshed = await refreshStoredCredentials({
			credentials,
			backend: input.backend,
			fetchFn: input.fetchFn,
		})
		try {
			return await invoke(refreshed.mcpUrl, refreshed.accessToken, input)
		} catch (retryError) {
			throw withOpenidScopeHint(retryError, refreshed.scope)
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

/**
 * Call one operation through the Kody MCP `api` tool as the `kody login`
 * session and return its `structuredContent.result`. Throws the platform error
 * message when the tool reports `isError`.
 */
export async function callKodyApiOperation(input: {
	operationId: string
	params: Record<string, unknown>
	mcpUrl?: string
	backend?: SecretBackend
	fetchFn?: typeof fetch
}): Promise<unknown> {
	const result = await callKodyTool({
		name: 'api',
		args: { operationId: input.operationId, params: input.params },
		mcpUrl: input.mcpUrl,
		backend: input.backend,
		fetchFn: input.fetchFn,
	})
	const structured = isRecord(result.structuredContent) ? result.structuredContent : null
	if (result.isError) {
		const error = structured && isRecord(structured.error) ? structured.error : null
		const message =
			error && typeof error.message === 'string'
				? error.message
				: result.content
						.map((part) => (typeof part.text === 'string' ? part.text : ''))
						.join('\n')
						.trim()
		throw new Error(message || `Kody api ${input.operationId} failed.`)
	}
	if (!structured || !('result' in structured)) {
		throw new Error(`Kody api ${input.operationId} returned no result.`)
	}
	return structured.result
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
	try {
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
	} catch (error) {
		throw withOpenidScopeHint(error, credentials.scope)
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
	return (
		status === 401 ||
		(error instanceof Error && /401|unauthorized/i.test(error.message))
	)
}

function withOpenidScopeHint(error: unknown, scope: string | undefined): Error {
	const redacted = redactError(error)
	if (
		/insufficient_scope/i.test(redacted.message) &&
		!scopeIncludesOpenid(scope)
	) {
		return new Error(`${redacted.message}\n${missingOpenidReloginHint}`)
	}
	return redacted
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
