import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { defaultMcpUrl, modernMcpProtocolVersion } from './defaults.js'
import { usage } from './help.js'
import { ensureFreshCredentials, login } from './auth.js'
import { deleteCredentials, loadCredentials } from './store.js'
import { callKodyTool, formatToolResult, listKodyTools } from './mcp.js'
import { installSkill } from './skill.js'
import { readPackageVersion } from './package-info.js'
import { redactError } from './redact.js'

export type CommandName =
	| 'login'
	| 'logout'
	| 'status'
	| 'whoami'
	| 'search'
	| 'execute'
	| 'skill'
	| 'help'
	| 'version'

function mcpUrlFrom(values: { mcpUrl?: string }): string {
	return values.mcpUrl || process.env.KODY_MCP_URL || defaultMcpUrl
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
			params: { type: 'string' },
			'conversation-id': { type: 'string' },
			project: { type: 'boolean' },
			'no-browser': { type: 'boolean' },
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
		return await dispatch(parsed, write)
	} catch (error) {
		writeErr(`${redactError(error).message}\n`)
		return 1
	}
}

async function dispatch(
	parsed: ReturnType<typeof resolveCommand>,
	write: (text: string) => void,
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
			const code =
				typeof parsed.values.code === 'string'
					? parsed.values.code
					: typeof parsed.values.file === 'string'
						? parsed.values.file === '-'
							? await readStdin()
							: await readFile(parsed.values.file, 'utf8')
						: parsed.positionals.join('\n').trim()
			if (!code) {
				throw new Error('Provide --code, --file, or a module string.')
			}
			const args: Record<string, unknown> = { code }
			if (typeof parsed.values.params === 'string') {
				args.params = JSON.parse(parsed.values.params)
			}
			if (typeof parsed.values['conversation-id'] === 'string') {
				args.conversationId = parsed.values['conversation-id']
			}
			const result = await callKodyTool({ name: 'execute', args, mcpUrl })
			write(formatToolResult(result, json))
			return result.isError ? 1 : 0
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
