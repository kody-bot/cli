import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import {
	hasExplicitTokenFlag,
	readApiToken,
	requireApiToken,
} from './api-token.js'
import { defaultApiUrl, defaultMcpUrl, modernMcpProtocolVersion } from './defaults.js'
import { usage } from './help.js'
import { ensureFreshCredentials, login } from './auth.js'
import { deleteCredentials, loadCredentials } from './store.js'
import { callKodyTool, formatToolResult, listKodyTools } from './mcp.js'
import { runInstall } from './install.js'
import { runLocalExecute } from './local-execute.js'
import { searchWithApiToken, whoamiWithApiToken } from './open-api-client.js'
import { runRemoteExecuteWithToken } from './remote-execute.js'
import { installSkill } from './skill.js'
import { readPackageVersion } from './package-info.js'
import { redactError } from './redact.js'

export { readApiToken, requireApiToken as resolveApiToken } from './api-token.js'

export type CommandName =
	| 'login'
	| 'logout'
	| 'status'
	| 'whoami'
	| 'search'
	| 'execute'
	| 'install'
	| 'skill'
	| 'help'
	| 'version'

function mcpUrlFrom(values: { mcpUrl?: string }): string {
	return values.mcpUrl || process.env.KODY_MCP_URL || defaultMcpUrl
}

export function apiUrlFrom(
	values: { apiUrl?: string },
	env: NodeJS.ProcessEnv = process.env,
): string {
	return values.apiUrl || env.KODY_API_URL || defaultApiUrl
}

function parseKnown(args: Array<string>) {
	return parseArgs({
		args,
		allowPositionals: true,
		strict: false,
		options: {
			help: { type: 'boolean', short: 'h' },
			version: { type: 'boolean', short: 'v' },
			json: { type: 'boolean' },
			'mcp-url': { type: 'string' },
			entity: { type: 'string' },
			domain: { type: 'string' },
			limit: { type: 'string' },
			code: { type: 'string' },
			file: { type: 'string' },
			invoke: { type: 'string' },
			params: { type: 'string' },
			'conversation-id': { type: 'string' },
			local: { type: 'boolean' },
			token: { type: 'string' },
			'api-url': { type: 'string' },
			project: { type: 'boolean' },
			'no-browser': { type: 'boolean' },
			clients: { type: 'string' },
			yes: { type: 'boolean', short: 'y' },
		},
	})
}

export function resolveCommand(argv: Array<string>): {
	command: CommandName
	positionals: Array<string>
	values: ReturnType<typeof parseKnown>['values']
} {
	const { positionals, values } = parseKnown(argv)
	if (values.help && positionals.length === 0) {
		return { command: 'help', positionals, values }
	}
	if (values.version && positionals.length === 0) {
		return { command: 'version', positionals, values }
	}
	const raw = positionals[0]
	if (!raw) return { command: 'help', positionals, values }
	switch (raw) {
		case 'login':
		case 'logout':
		case 'status':
		case 'whoami':
		case 'search':
		case 'execute':
		case 'install':
		case 'skill':
		case 'help':
		case 'version':
			return { command: raw, positionals: positionals.slice(1), values }
		default:
			throw new Error(`Unknown command "${raw}".\n\n${usage}`)
	}
}

export async function runCli(
	argv: Array<string> = process.argv.slice(2),
	io: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
): Promise<number> {
	const write = io.stdout ?? ((text: string) => process.stdout.write(text))
	const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text))
	try {
		const parsed = resolveCommand(argv)
		if (parsed.values.help && parsed.command !== 'help') {
			write(usage)
			return 0
		}
		return await dispatch(parsed, write, writeErr)
	} catch (error) {
		writeErr(`${redactError(error).message}\n`)
		return 1
	}
}

async function dispatch(
	parsed: ReturnType<typeof resolveCommand>,
	write: (text: string) => void,
	writeErr: (text: string) => void,
): Promise<number> {
	const mcpUrl = mcpUrlFrom({
		mcpUrl: typeof parsed.values['mcp-url'] === 'string' ? parsed.values['mcp-url'] : undefined,
	})
	const json = parsed.values.json === true

	switch (parsed.command) {
		case 'help':
			write(usage)
			return 0
		case 'version':
			write(`${readPackageVersion()}\n`)
			return 0
		case 'login': {
			write('Opening the Kody login page in your browser…\n')
			const result = await login({
				mcpUrl,
				openBrowser: parsed.values['no-browser'] !== true,
				onAuthorizationUrl: (url) => {
					write(`If the browser does not open, visit:\n${url.href}\n`)
				},
			})
			write(`Logged in to ${result.credentials.mcpUrl}.\n`)
			if (result.backendKind === 'file' && result.backendPath) {
				write(
					`OS keychain was unavailable; credentials saved at ${result.backendPath} (mode 0600).\n`,
				)
			} else {
				write('Credentials stored in the OS keychain.\n')
			}
			return 0
		}
		case 'logout': {
			const result = deleteCredentials(mcpUrl)
			write(result.deleted ? 'Logged out.\n' : 'No stored credentials.\n')
			return 0
		}
		case 'status': {
			const credentials = loadCredentials(mcpUrl)
			if (!credentials) {
				write('Not logged in.\n')
				return 1
			}
			const expires = credentials.expiresAt
				? new Date(credentials.expiresAt).toISOString()
				: 'unknown'
			write(
				[
					`mcp: ${credentials.mcpUrl}`,
					`logged in: yes`,
					`access token expires: ${expires}`,
					`refresh token: ${credentials.refreshToken ? 'yes' : 'no'}`,
					`scope: ${credentials.scope ?? 'unknown'}`,
					'',
				].join('\n'),
			)
			return 0
		}
		case 'whoami': {
			const tokenValues = tokenFlagValues(parsed.values)
			const apiToken = readApiToken(tokenValues)
			if (shouldUseApiToken({ tokenValues, mcpUrl, allowEnvWithoutLogin: true })) {
				const identity = await whoamiWithApiToken({
					token: requireApiToken(tokenValues, process.env, 'whoami'),
					apiUrl: apiUrlFrom({
						apiUrl:
							typeof parsed.values['api-url'] === 'string'
								? parsed.values['api-url']
								: undefined,
					}),
				})
				if (json) {
					write(`${JSON.stringify(identity, null, 2)}\n`)
					return 0
				}
				const scopeLine = identity.token.scopes.join(', ') || '(none)'
				const userLine = identity.user
					? `${identity.user.displayName} <${identity.user.email}>`
					: '(account:read not on this token)'
				write(
					[
						`api: ${identity.apiUrl}`,
						`auth: API token (${identity.token.id})`,
						`user: ${userLine}`,
						`scopes: ${scopeLine}`,
						`expires: ${identity.token.expiresAt ?? 'unknown'}`,
						'',
					].join('\n'),
				)
				return 0
			}
			const credentials = await ensureFreshCredentials({ mcpUrl })
			const tools = await listKodyTools({ mcpUrl })
			if (json) {
				write(
					`${JSON.stringify(
						{
							mcpUrl: credentials.mcpUrl,
							protocol: modernMcpProtocolVersion,
							scope: credentials.scope ?? null,
							tools: tools.map((tool) => tool.name),
						},
						null,
						2,
					)}\n`,
				)
				return 0
			}
			write(
				`Connected to ${credentials.mcpUrl} (${modernMcpProtocolVersion})\nTools: ${tools.map((tool) => tool.name).join(', ') || '(none)'}\n`,
			)
			return 0
		}
		case 'search': {
			const query = parsed.positionals.join(' ').trim()
			const tokenValues = tokenFlagValues(parsed.values)
			if (shouldUseApiToken({ tokenValues, mcpUrl, allowEnvWithoutLogin: true })) {
				const result = await searchWithApiToken({
					token: requireApiToken(tokenValues, process.env, 'search'),
					apiUrl: apiUrlFrom({
						apiUrl:
							typeof parsed.values['api-url'] === 'string'
								? parsed.values['api-url']
								: undefined,
					}),
					query: query || undefined,
					entity:
						typeof parsed.values.entity === 'string' ? parsed.values.entity : undefined,
					domain:
						typeof parsed.values.domain === 'string' ? parsed.values.domain : undefined,
					limit:
						typeof parsed.values.limit === 'string'
							? Number(parsed.values.limit)
							: undefined,
				})
				write(formatToolResult(result, json))
				return result.isError ? 1 : 0
			}
			const args: Record<string, unknown> = {}
			if (query) args.query = query
			if (typeof parsed.values.entity === 'string') args.entity = parsed.values.entity
			if (typeof parsed.values.domain === 'string') args.domain = parsed.values.domain
			if (typeof parsed.values.limit === 'string') args.limit = Number(parsed.values.limit)
			const result = await callKodyTool({ name: 'search', args, mcpUrl })
			write(formatToolResult(result, json))
			return result.isError ? 1 : 0
		}
		case 'execute': {
			const invoke =
				typeof parsed.values.invoke === 'string' ? parsed.values.invoke : undefined
			const hasCodeFlag = typeof parsed.values.code === 'string'
			const hasFileFlag = typeof parsed.values.file === 'string'
			const positionalModule = parsed.positionals.join('\n').trim()
			const local = parsed.values.local === true
			const tokenValues = tokenFlagValues(parsed.values)
			if (local && invoke !== undefined) {
				throw new Error(
					'--invoke runs a saved package export in Kody; --local runs a module you provide (--code, --file, or a module string).',
				)
			}
			if (executeSourcesConflict({ invoke, hasCodeFlag, hasFileFlag, positionalModule })) {
				throw new Error(
					'--invoke cannot be combined with --code, --file, or a module string.',
				)
			}
			const code =
				invoke !== undefined
					? undefined
					: hasCodeFlag
						? parsed.values.code
						: hasFileFlag
							? parsed.values.file === '-'
								? await readStdin()
								: await readFile(parsed.values.file as string, 'utf8')
							: positionalModule || undefined
			const args = buildExecuteToolArgs({
				invoke,
				code: typeof code === 'string' ? code : undefined,
				paramsJson:
					typeof parsed.values.params === 'string' ? parsed.values.params : undefined,
				conversationId:
					typeof parsed.values['conversation-id'] === 'string'
						? parsed.values['conversation-id']
						: undefined,
			})
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			const useToken =
				local ||
				shouldUseApiToken({
					tokenValues,
					mcpUrl,
					allowEnvWithoutLogin: true,
				})
			const result = local
				? await runLocalExecute({
						code: args.code as string,
						params: args.params,
						conversationId: args.conversationId as string | undefined,
						token: requireApiToken(tokenValues, process.env, 'execute --local'),
						apiUrl,
						onStatus: (message) => writeErr(`${message}\n`),
					})
				: useToken
					? await runRemoteExecuteWithToken({
							code: typeof args.code === 'string' ? args.code : undefined,
							invoke,
							params: args.params,
							conversationId: args.conversationId as string | undefined,
							token: requireApiToken(
								tokenValues,
								process.env,
								'execute with an API token',
							),
							apiUrl,
						})
					: await callKodyTool({ name: 'execute', args, mcpUrl })
			write(formatToolResult(result, json))
			return result.isError ? 1 : 0
		}
		case 'install': {
			const result = await runInstall(
				{
					mcpUrl,
					clients:
						typeof parsed.values.clients === 'string' ? parsed.values.clients : undefined,
					yes: parsed.values.yes === true,
					project: parsed.values.project === true,
					json,
				},
				{ stdout: write },
			)
			return result.code
		}
		case 'skill': {
			const action = parsed.positionals[0] ?? 'install'
			if (action !== 'install') {
				throw new Error('Usage: kody skill install [--project]')
			}
			const targets = await installSkill({ project: parsed.values.project === true })
			write(
				`Installed the Kody skill to:\n${targets.map((target) => `- ${target.host}: ${target.path}`).join('\n')}\n`,
			)
			return 0
		}
		default: {
			const exhaustive: never = parsed.command
			throw new Error(`Unhandled command: ${String(exhaustive)}`)
		}
	}
}

async function readStdin(): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

/** True when --invoke is set alongside any code source (--code, --file, or positional). */
export function executeSourcesConflict(input: {
	invoke?: string
	hasCodeFlag: boolean
	hasFileFlag: boolean
	positionalModule: string
}): boolean {
	return (
		input.invoke !== undefined &&
		(input.hasCodeFlag || input.hasFileFlag || input.positionalModule.length > 0)
	)
}

/**
 * Build MCP `execute` tool args from CLI inputs.
 * Pass either `invoke` or resolved `code` (from --code, --file, or a module string).
 */
export function buildExecuteToolArgs(input: {
	invoke?: string
	code?: string
	paramsJson?: string
	conversationId?: string
}): Record<string, unknown> {
	const invoke = input.invoke
	const code = input.code
	if (invoke !== undefined && code !== undefined && code.length > 0) {
		throw new Error('--invoke cannot be combined with --code, --file, or a module string.')
	}
	if (invoke !== undefined) {
		if (!invoke) {
			throw new Error('Provide a non-empty --invoke value.')
		}
		return attachExecuteCommonArgs({ invoke }, input)
	}
	if (code) {
		return attachExecuteCommonArgs({ code }, input)
	}
	throw new Error('Provide --invoke, --code, --file, or a module string.')
}

function attachExecuteCommonArgs(
	args: Record<string, unknown>,
	input: { paramsJson?: string; conversationId?: string },
): Record<string, unknown> {
	if (input.paramsJson !== undefined) {
		args.params = JSON.parse(input.paramsJson)
	}
	if (input.conversationId !== undefined) {
		args.conversationId = input.conversationId
	}
	return args
}

function tokenFlagValues(values: ReturnType<typeof parseKnown>['values']): {
	token?: string
} {
	return {
		token: typeof values.token === 'string' ? values.token : undefined,
	}
}

/**
 * Prefer a scoped API token when the user passed `--token`, or when
 * `KODY_API_TOKEN` is set and there is no stored `kody login` session.
 * Logged-in MCP OAuth still wins over an env-only token so a leftover
 * `KODY_API_TOKEN` does not hijack cloud MCP commands.
 */
export function shouldUseApiToken(input: {
	tokenValues: { token?: string }
	mcpUrl: string
	allowEnvWithoutLogin: boolean
	env?: NodeJS.ProcessEnv
	/** Override session detection (tests). */
	hasSession?: boolean
}): boolean {
	if (hasExplicitTokenFlag(input.tokenValues)) return true
	if (!input.allowEnvWithoutLogin) return false
	if (!readApiToken(input.tokenValues, input.env)) return false
	const loggedIn =
		input.hasSession ?? loadCredentials(input.mcpUrl) != null
	return !loggedIn
}
