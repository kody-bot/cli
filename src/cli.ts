import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import {
	cliBootstrapMintCall,
	hasExplicitTokenFlag,
	requireApiToken,
	resolveScopedApiToken,
} from './api-token.js'
import {
	deleteStoredApiToken,
	loadStoredApiToken,
} from './api-token-store.js'
import {
	authBootstrap,
	authBootstrapWithScopes,
	bootstrapMintLifetimeFields,
	cliCredentialBootstrapOperationId,
	parseCliLifetimeSecondsFlag,
	parseCliScopesFlag,
	resolveCliTokenLifetime,
	type ResolvedCliTokenLifetime,
} from './auth-bootstrap.js'
import {
	parseCredentialFlags,
	type CredentialCallMapInput,
} from './credential-call-map.js'
import { defaultApiUrl, defaultMcpUrl, modernMcpProtocolVersion } from './defaults.js'
import { buildUsage, usage } from './help.js'
import {
	chooseOrgInteractively,
	formatOrgListHuman,
	formatOrgListJson,
	resolveOrgSlug,
	useOrg,
} from './org.js'
import { refreshGitCredentialHelperPinIfNeeded } from './setup-git.js'
import {
	deleteCredentials,
	listStoredOrgs,
	loadCredentials,
} from './store.js'
import { formatToolResult } from './tool-result.js'
import { resolveLocalExecuteBearer } from './local-execute-auth.js'
import { assertLocalExecuteNodeEngine } from './node-engine.js'
import { readPackageVersion } from './package-info.js'
import { redactError } from './redact.js'

export {
	readApiToken,
	requireApiToken as resolveApiToken,
	resolveScopedApiToken,
} from './api-token.js'
export { resolveLocalExecuteBearer } from './local-execute-auth.js'
export {
	authBootstrap,
	authBootstrapWithScopes,
	bootstrapRedeemRequestBody,
	cliTokenLifetimeAliases,
	cliTokenLifetimeMissingError,
	cliTokenLifetimePolicy,
	parseCliLifetimeSecondsFlag,
	parseCliScopesFlag,
	redeemBootstrapCode,
	resolveCliTokenLifetime,
} from './auth-bootstrap.js'

export type CommandName =
	| 'login'
	| 'logout'
	| 'org'
	| 'status'
	| 'auth'
	| 'git-credential'
	| 'whoami'
	| 'search'
	| 'api'
	| 'execute'
	| 'install'
	| 'skill'
	| 'help'
	| 'version'

const orgScopedCommands = new Set<CommandName>([
	'login',
	'logout',
	'whoami',
	'search',
	'api',
	'execute',
	'auth',
])

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
			'allow-private-network': { type: 'boolean' },
			credential: { type: 'string', multiple: true },
			token: { type: 'string' },
			'api-url': { type: 'string' },
			lifetime: { type: 'string' },
			'idle-ttl-seconds': { type: 'string' },
			'max-lifetime-seconds': { type: 'string' },
			scopes: { type: 'string' },
			project: { type: 'boolean' },
			'no-browser': { type: 'boolean' },
			org: { type: 'string' },
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
		case 'org':
		case 'status':
		case 'auth':
		case 'git-credential':
		case 'whoami':
		case 'search':
		case 'api':
		case 'execute':
		case 'install':
		case 'skill':
		case 'help':
		case 'version':
			return { command: raw, positionals: positionals.slice(1), values }
		default:
			// Never embed full usage here: git credential helpers treat any
			// unexpected stdout as protocol data, and older CLIs that dumped
			// help on unknown commands broke `git push`. Keep the hint short;
			// `runCli` always writes errors to stderr only.
			throw new Error(
				`Unknown command "${raw}". Run \`kody --help\` for usage.`,
			)
	}
}

export async function runCli(
	argv: Array<string> = process.argv.slice(2),
	io: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
): Promise<number> {
	const write = io.stdout ?? ((text: string) => process.stdout.write(text))
	const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text))
	// Best-effort: upgrade stale git helper pins (major-only / ephemeral /
	// outdated exact) before any command, including git-credential. Must not
	// write to stdout — git reads the helper protocol from stdout only.
	// Skip under node:test so unit tests never rewrite the developer's
	// global git config; production / E2E / npx always refresh.
	if (
		process.env.NODE_TEST !== '1' &&
		process.env.KODY_SKIP_GIT_HELPER_REFRESH !== '1'
	) {
		try {
			refreshGitCredentialHelperPinIfNeeded({
				mcpUrl: process.env.KODY_MCP_URL || undefined,
			})
		} catch {
			// Ignore refresh failures; the user's command still runs.
		}
	}
	try {
		const parsed = resolveCommand(argv)
		const helpMcpUrl = mcpUrlFrom({
			mcpUrl:
				typeof parsed.values['mcp-url'] === 'string'
					? parsed.values['mcp-url']
					: undefined,
		})
		if (parsed.values.help && parsed.command !== 'help') {
			write(buildUsage({ mcpUrl: helpMcpUrl }))
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
	if (
		parsed.values['allow-private-network'] === true &&
		(parsed.command !== 'execute' || parsed.values.local !== true)
	) {
		throw new Error('--allow-private-network can only be used with execute --local.')
	}
	const orgFlag =
		typeof parsed.values.org === 'string' ? parsed.values.org : undefined
	if (orgFlag !== undefined && !orgScopedCommands.has(parsed.command)) {
		throw new Error(
			`\`--org\` is not used with \`kody ${parsed.command}\`. Use it with login, logout, whoami, search, api, execute, or auth.`,
		)
	}
	const org = resolveOrgSlug({ flag: orgFlag })

	switch (parsed.command) {
		case 'help':
			write(buildUsage({ mcpUrl }))
			return 0
		case 'version':
			write(`${readPackageVersion()}\n`)
			return 0
		case 'login': {
			const { login } = await import('./auth.js')
			write('Opening the Kody login page in your browser…\n')
			const result = await login({
				mcpUrl,
				...(org ? { org } : {}),
				openBrowser: parsed.values['no-browser'] !== true,
				onAuthorizationUrl: (url) => {
					write(`If the browser does not open, visit:\n${url.href}\n`)
				},
			})
			const orgLabel = result.org
				? ` as org ${result.org}`
				: result.credentials.org
					? ` as org ${result.credentials.org}`
					: ''
			const accountLabel = result.account?.email
				? ` (${result.account.email})`
				: result.account?.displayName
					? ` (${result.account.displayName})`
					: ''
			write(`Logged in to ${result.credentials.mcpUrl}${orgLabel}${accountLabel}.\n`)
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
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			const oauth = deleteCredentials(
				mcpUrl,
				undefined,
				undefined,
				org ? { org } : undefined,
			)
			// Clear the bootstrap/API token only when removing the last org login
			// or when not targeting a specific remaining multi-org set.
			const clearApiToken = !org || oauth.remaining === 0
			const apiToken = clearApiToken
				? deleteStoredApiToken(apiUrl)
				: { deleted: false }
			if (!oauth.deleted && !apiToken.deleted) {
				write(
					org
						? `No stored login for org "${org}".\n`
						: 'No stored credentials.\n',
				)
				return 0
			}
			const parts: Array<string> = []
			if (oauth.deleted) {
				parts.push(
					org
						? `Logged out of org ${org}.`
						: 'Logged out of the active org (kody login).',
				)
			}
			if (apiToken.deleted) parts.push('Cleared stored bootstrap/API token.')
			write(`${parts.join(' ')}\n`)
			return 0
		}
		case 'org': {
			const action = parsed.positionals[0]
			if (action === 'list') {
				const orgs = listStoredOrgs(mcpUrl)
				write(json ? formatOrgListJson(orgs) : formatOrgListHuman(orgs))
				return orgs.length === 0 ? 1 : 0
			}
			if (action === 'use') {
				const slugArg = parsed.positionals[1]
				if (slugArg) {
					const next = useOrg(slugArg, mcpUrl)
					write(`Active org is now ${next.activeOrg}.\n`)
					return 0
				}
				const orgs = listStoredOrgs(mcpUrl)
				const chosen = await chooseOrgInteractively({ orgs })
				const next = useOrg(chosen, mcpUrl)
				write(`Active org is now ${next.activeOrg}.\n`)
				return 0
			}
			throw new Error('Usage: kody org list [--json] | kody org use [<slug>]')
		}
		case 'status': {
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			const credentials = loadCredentials(mcpUrl, undefined, undefined, {
				org,
			})
			const orgs = listStoredOrgs(mcpUrl)
			const storedApi = loadStoredApiToken(apiUrl)
			if (!credentials && orgs.length === 0 && !storedApi) {
				write('Not logged in.\n')
				return 1
			}
			const lines: Array<string> = []
			if (credentials || orgs.length > 0) {
				const expires = credentials?.expiresAt
					? new Date(credentials.expiresAt).toISOString()
					: 'unknown'
				lines.push(
					`mcp: ${credentials?.mcpUrl ?? mcpUrl}`,
					`logged in: yes`,
					`active org: ${credentials?.org ?? orgs.find((row) => row.active)?.slug ?? '(pending)'}`,
					`orgs: ${orgs.map((row) => (row.active ? `${row.slug}*` : row.slug)).join(', ') || '(pending)'}`,
					`access token expires: ${expires}`,
					`refresh token: ${credentials?.refreshToken ? 'yes' : 'no'}`,
					`scope: ${credentials?.scope ?? 'unknown'}`,
				)
			} else {
				lines.push(`mcp: ${mcpUrl}`, `logged in: no`)
			}
			if (storedApi) {
				const scopes = storedApi.scopes?.join(', ') || '(unknown)'
				lines.push(
					`api: ${storedApi.apiUrl}`,
					`stored API token: yes (${storedApi.tokenId})`,
					`API token scopes: ${scopes}`,
					`API token expires: ${storedApi.expiresAt ?? 'unknown'}`,
					`API token via: ${storedApi.createdVia ?? 'unknown'}`,
				)
			} else {
				lines.push(`api: ${apiUrl}`, `stored API token: no`)
			}
			lines.push('')
			write(lines.join('\n'))
			return 0
		}
		case 'auth': {
			const action = parsed.positionals[0]
			if (action === 'setup-git') {
				return runAuthSetupGit({
					values: parsed.values,
					mcpUrl,
					write,
				})
			}
			if (action === 'remove-git') {
				return runAuthRemoveGit({
					values: parsed.values,
					mcpUrl,
					write,
				})
			}
			if (action !== 'bootstrap') {
				throw new Error(
					'Usage: kody auth bootstrap (…) | kody auth setup-git […] | kody auth remove-git [--api-url <url>] [--mcp-url <url>]',
				)
			}
			const code =
				typeof parsed.values.code === 'string' ? parsed.values.code.trim() : ''
			const scopes = parseCliScopesFlag(
				typeof parsed.values.scopes === 'string' ? parsed.values.scopes : undefined,
			)
			if (!code && !scopes) {
				throw new Error(
					'Provide --code <kody_bc_…> from cliCredentialBootstrap (MCP api / kody.cliCredentialBootstrap), or --scopes <list> to mint one with the current kody login session or API token.',
				)
			}
			const lifetime = resolveCliTokenLifetime({
				lifetime:
					typeof parsed.values.lifetime === 'string'
						? parsed.values.lifetime
						: undefined,
				idleTtlSeconds: parseCliLifetimeSecondsFlag(
					typeof parsed.values['idle-ttl-seconds'] === 'string'
						? parsed.values['idle-ttl-seconds']
						: undefined,
					'--idle-ttl-seconds',
				),
				maxLifetimeSeconds: parseCliLifetimeSecondsFlag(
					typeof parsed.values['max-lifetime-seconds'] === 'string'
						? parsed.values['max-lifetime-seconds']
						: undefined,
					'--max-lifetime-seconds',
				),
			})
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			if (code && scopes) {
				throw new Error(
					`--scopes cannot change a bootstrap code: its scopes are fixed when it is minted. From Kody MCP, call \`${cliBootstrapMintCall(scopes, bootstrapMintLifetimeFields(lifetime))}\` and redeem the new code, or drop --code to mint with the current kody login session or API token.`,
				)
			}
			const result = scopes
				? await authBootstrapWithScopes({
						scopes,
						lifetime,
						apiUrl,
						mint: bootstrapMinter({
							scopes,
							lifetime,
							mcpUrl,
							apiUrl,
							tokenValues: tokenFlagValues(parsed.values),
						}),
					})
				: await authBootstrap({
						code,
						apiUrl,
						...(lifetime.kind === 'alias'
							? { lifetime: lifetime.lifetime }
							: {
									idleTtlSeconds: lifetime.idleTtlSeconds,
									maxLifetimeSeconds: lifetime.maxLifetimeSeconds,
								}),
					})
			const storedScopes = result.stored.scopes?.join(', ') || '(none)'
			write(
				[
					`Bootstrap API token stored for execute --local, search, whoami, api, and token-auth cloud execute.`,
					`api: ${result.stored.apiUrl}`,
					`token id: ${result.stored.tokenId}`,
					`scopes: ${storedScopes}`,
					`expires: ${result.stored.expiresAt ?? 'unknown'}`,
					result.backendKind === 'file' && result.backendPath
						? `OS keychain was unavailable; token saved at ${result.backendPath} (mode 0600).`
						: 'Token stored in the OS keychain.',
					'',
				].join('\n'),
			)
			return 0
		}
		case 'git-credential': {
			const {
				handleGitCredential,
				parseGitCredentialAction,
				parseGitCredentialInput,
				readGitCredentialStdin,
			} = await import('./git-credential.js')
			const action = parseGitCredentialAction(parsed.positionals)
			const raw = await readGitCredentialStdin(process.stdin)
			const output = await handleGitCredential({
				action,
				request: parseGitCredentialInput(raw),
				apiUrl: apiUrlFrom({
					apiUrl:
						typeof parsed.values['api-url'] === 'string'
							? parsed.values['api-url']
							: undefined,
				}),
				mcpUrl,
			})
			if (output) process.stdout.write(output)
			return 0
		}
		case 'whoami': {
			const tokenValues = tokenFlagValues(parsed.values)
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			if (
				shouldUseApiToken({
					tokenValues,
					mcpUrl,
					apiUrl,
					allowEnvWithoutLogin: true,
				})
			) {
				const { whoamiWithApiToken } = await import('./open-api-client.js')
				const identity = await whoamiWithApiToken({
					token: requireApiToken(tokenValues, process.env, 'whoami', { apiUrl }),
					apiUrl,
					...(org ? { org } : {}),
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
			const [{ ensureFreshCredentials }, { listKodyTools }] = await Promise.all([
				import('./auth.js'),
				import('./mcp.js'),
			])
			const credentials = await ensureFreshCredentials({ mcpUrl, org })
			const tools = await listKodyTools({ mcpUrl, org })
			if (json) {
				write(
					`${JSON.stringify(
						{
							mcpUrl: credentials.mcpUrl,
							org: credentials.org ?? null,
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
			const orgLine = credentials.org ? `\norg: ${credentials.org}` : ''
			write(
				`Connected to ${credentials.mcpUrl} (${modernMcpProtocolVersion})${orgLine}\nTools: ${tools.map((tool) => tool.name).join(', ') || '(none)'}\n`,
			)
			return 0
		}
		case 'search': {
			const query = parsed.positionals.join(' ').trim()
			const tokenValues = tokenFlagValues(parsed.values)
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			if (
				shouldUseApiToken({
					tokenValues,
					mcpUrl,
					apiUrl,
					allowEnvWithoutLogin: true,
				})
			) {
				const { searchWithApiToken } = await import('./open-api-client.js')
				const result = await searchWithApiToken({
					token: requireApiToken(tokenValues, process.env, 'search', { apiUrl }),
					apiUrl,
					...(org ? { org } : {}),
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
			const { callKodyTool } = await import('./mcp.js')
			const result = await callKodyTool({
				name: 'search',
				args,
				mcpUrl,
				...(org ? { org } : {}),
			})
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
			if (local) assertLocalExecuteNodeEngine()
			const fileArg = hasFileFlag ? (parsed.values.file as string) : undefined
			// `--code` wins over `--file`. Only attribute the path when the file is the source.
			const modulePath =
				!hasCodeFlag && fileArg !== undefined && fileArg !== '-' ? fileArg : undefined
			const code =
				invoke !== undefined
					? undefined
					: hasCodeFlag
						? parsed.values.code
						: modulePath !== undefined
							? await readFile(modulePath, 'utf8')
							: fileArg === '-'
								? await readStdin()
								: positionalModule || undefined
			const credentials = parseCredentialFlags(
				Array.isArray(parsed.values.credential)
					? parsed.values.credential.filter(
							(value): value is string => typeof value === 'string',
						)
					: typeof parsed.values.credential === 'string'
						? [parsed.values.credential]
						: undefined,
			)
			const args = buildExecuteToolArgs({
				invoke,
				code: typeof code === 'string' ? code : undefined,
				paramsJson:
					typeof parsed.values.params === 'string' ? parsed.values.params : undefined,
				conversationId:
					typeof parsed.values['conversation-id'] === 'string'
						? parsed.values['conversation-id']
						: undefined,
				credentials,
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
					apiUrl,
					allowEnvWithoutLogin: true,
				})
			const result = local
				? await (await import('./local-execute.js')).runLocalExecute({
						code: args.code as string,
						...(modulePath !== undefined ? { modulePath } : {}),
						params: args.params,
						conversationId: args.conversationId as string | undefined,
						...(credentials !== undefined ? { credentials } : {}),
						token: await resolveLocalExecuteBearer({
							tokenValues,
							mcpUrl,
							apiUrl,
							purpose: 'execute --local',
							...(org ? { org } : {}),
						}),
						apiUrl,
						...(org ? { org } : {}),
						allowPrivateNetwork:
							parsed.values['allow-private-network'] === true,
						onStatus: (message) => writeErr(`${message}\n`),
					})
				: useToken
					? await (await import('./remote-execute.js')).runRemoteExecuteWithToken({
							code: typeof args.code === 'string' ? args.code : undefined,
							invoke,
							params: args.params,
							conversationId: args.conversationId as string | undefined,
							...(credentials !== undefined ? { credentials } : {}),
							token: requireApiToken(
								tokenValues,
								process.env,
								'execute with an API token',
								{ apiUrl },
							),
							apiUrl,
							...(org ? { org } : {}),
						})
					: await (await import('./mcp.js')).callKodyTool({
							name: 'execute',
							args,
							mcpUrl,
							...(org ? { org } : {}),
						})
			write(formatToolResult(result, json))
			return result.isError ? 1 : 0
		}
		case 'api': {
			const operationId = parsed.positionals[0]?.trim() ?? ''
			if (!operationId || parsed.positionals.length > 1) {
				throw new Error(
					'Usage: kody api <operationId> [--params <json>] [--token <token>] [--api-url <url>] [--json]',
				)
			}
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			const tokenValues = tokenFlagValues(parsed.values)
			const params = parseApiParamsJson(
				typeof parsed.values.params === 'string' ? parsed.values.params : undefined,
			)
			const { callOpenApiOperation } = await import('./open-api-client.js')
			const result = await callOpenApiOperation({
				operationId,
				params,
				token: requireApiToken(tokenValues, process.env, 'api', { apiUrl }),
				apiUrl,
				...(org ? { org } : {}),
			})
			// Always JSON: mirrors MCP `api` structured results for agents/scripts.
			write(`${JSON.stringify(result, null, 2)}\n`)
			return 0
		}
		case 'install': {
			const { runInstall } = await import('./install.js')
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
			const { installSkill } = await import('./skill.js')
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
	credentials?: CredentialCallMapInput
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
	input: {
		paramsJson?: string
		conversationId?: string
		credentials?: CredentialCallMapInput
	},
): Record<string, unknown> {
	if (input.paramsJson !== undefined) {
		args.params = JSON.parse(input.paramsJson)
	}
	if (input.conversationId !== undefined) {
		args.conversationId = input.conversationId
	}
	if (input.credentials !== undefined) {
		args.credentials = input.credentials
	}
	return args
}

async function runAuthSetupGit(input: {
	values: ReturnType<typeof parseKnown>['values']
	mcpUrl: string
	write: (text: string) => void
}): Promise<number> {
	const { authSetupGit, setupGitDefaultScopes } = await import('./setup-git.js')
	const apiUrl = apiUrlFrom({
		apiUrl:
			typeof input.values['api-url'] === 'string'
				? input.values['api-url']
				: undefined,
	})
	const scopes = parseCliScopesFlag(
		typeof input.values.scopes === 'string' ? input.values.scopes : undefined,
	)
	const lifetime = resolveCliTokenLifetime({
		lifetime:
			typeof input.values.lifetime === 'string'
				? input.values.lifetime
				: 'long',
		idleTtlSeconds: parseCliLifetimeSecondsFlag(
			typeof input.values['idle-ttl-seconds'] === 'string'
				? input.values['idle-ttl-seconds']
				: undefined,
			'--idle-ttl-seconds',
		),
		maxLifetimeSeconds: parseCliLifetimeSecondsFlag(
			typeof input.values['max-lifetime-seconds'] === 'string'
				? input.values['max-lifetime-seconds']
				: undefined,
			'--max-lifetime-seconds',
		),
	})
	const tokenValues = tokenFlagValues(input.values)
	const mintScopes = scopes ?? setupGitDefaultScopes
	const hasLoginSession = loadCredentials(input.mcpUrl) != null
	const result = await authSetupGit({
		apiUrl,
		mcpUrl: input.mcpUrl,
		token: tokenValues.token,
		hasLoginSession,
		...(scopes ? { scopesOverride: scopes } : {}),
		lifetime,
		mint: bootstrapMinter({
			scopes: mintScopes,
			lifetime,
			mcpUrl: input.mcpUrl,
			apiUrl,
			tokenValues,
		}),
	})
	input.write(
		[
			`Git HTTPS credential helper installed for https://${result.host}/`,
			`helper: ${result.helperCommand}`,
			`token: ${result.minted ? 'minted' : 'reused'} ${result.tokenId} (org_binding=user)`,
			`scopes: ${result.scopes.join(', ') || '(none)'}`,
			`expires: ${result.expiresAt ?? 'unknown'}`,
			result.backendKind === 'file' && result.backendPath
				? `OS keychain was unavailable; token saved at ${result.backendPath} (mode 0600).`
				: result.minted
					? 'Token stored in the OS keychain (or existing store).'
					: 'Using the existing stored API token.',
			'',
			'This user-owned token authorizes every @owner/name.git you can access (all orgs).',
			'Try: git clone https://kody.codes/@owner/name.git',
			'Undo later: kody auth remove-git',
			'',
		].join('\n'),
	)
	return 0
}

async function runAuthRemoveGit(input: {
	values: ReturnType<typeof parseKnown>['values']
	mcpUrl: string
	write: (text: string) => void
}): Promise<number> {
	const { authRemoveGit, formatAuthRemoveGitReport } = await import('./setup-git.js')
	const apiUrl = apiUrlFrom({
		apiUrl:
			typeof input.values['api-url'] === 'string'
				? input.values['api-url']
				: undefined,
	})
	const result = await authRemoveGit({
		apiUrl,
		mcpUrl: input.mcpUrl,
	})
	input.write(formatAuthRemoveGitReport(result))
	return 0
}

/**
 * Pick the credential that mints a scoped bootstrap code: `--token`, else the
 * `kody login` session (MCP `api`), else KODY_API_TOKEN / a stored token (Open
 * API). A token can only mint scopes it already holds; a login session can mint
 * any scope the account's org role grants.
 */
function bootstrapMinter(input: {
	scopes: ReadonlyArray<string>
	lifetime: ResolvedCliTokenLifetime
	mcpUrl: string
	apiUrl: string
	tokenValues: { token?: string }
}): (params: Record<string, unknown>) => Promise<unknown> {
	// Resolve credentials lazily so `auth setup-git` can validate login/token
	// presence (and print its own guidance) before mint runs.
	return async (params) => {
		if (
			shouldUseApiToken({
				tokenValues: input.tokenValues,
				mcpUrl: input.mcpUrl,
				apiUrl: input.apiUrl,
				allowEnvWithoutLogin: true,
			})
		) {
			const token = requireApiToken(input.tokenValues, process.env, 'auth bootstrap --scopes', {
				apiUrl: input.apiUrl,
			})
			const { callOpenApiOperation } = await import('./open-api-client.js')
			try {
				return await callOpenApiOperation({
					token,
					apiUrl: input.apiUrl,
					operationId: cliCredentialBootstrapOperationId,
					params,
				})
			} catch (error) {
				if (error instanceof Error && /cannot grant scopes it does not hold/i.test(error.message)) {
					throw new Error(
						`${error.message} A token can only mint scopes it already holds. Run \`kody login\` and retry without --token (a login session can mint any scope your org role grants), or from Kody MCP call \`${cliBootstrapMintCall(input.scopes, bootstrapMintLifetimeFields(input.lifetime))}\` and run the returned cli_command.`,
					)
				}
				throw error
			}
		}
		if (loadCredentials(input.mcpUrl)) {
			return (await import('./mcp.js')).callKodyApiOperation({
				operationId: cliCredentialBootstrapOperationId,
				params,
				mcpUrl: input.mcpUrl,
			})
		}
		throw new Error(
			`auth bootstrap --scopes mints with your current Kody credential, and none was found. Run \`kody login\` and retry, or from Kody MCP call \`${cliBootstrapMintCall(input.scopes, bootstrapMintLifetimeFields(input.lifetime))}\` and run the returned cli_command.`,
		)
	}
}

function tokenFlagValues(values: ReturnType<typeof parseKnown>['values']): {
	token?: string
} {
	return {
		token: typeof values.token === 'string' ? values.token : undefined,
	}
}

/** Parse `--params` JSON for `kody api` (flat object, same as MCP `api`). */
export function parseApiParamsJson(paramsJson?: string): Record<string, unknown> {
	if (paramsJson === undefined) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(paramsJson)
	} catch {
		throw new Error('--params must be valid JSON (a flat object).')
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('--params must be a JSON object (e.g. \'{"query":"email"}\').')
	}
	return parsed as Record<string, unknown>
}

/**
 * Prefer a scoped API token when the user passed `--token`, or when
 * `KODY_API_TOKEN` / a stored bootstrap token is available and there is no
 * stored `kody login` session. Logged-in MCP OAuth still wins over an
 * env-only or stored token so a leftover token does not hijack cloud MCP
 * commands.
 */
export function shouldUseApiToken(input: {
	tokenValues: { token?: string }
	mcpUrl: string
	allowEnvWithoutLogin: boolean
	env?: NodeJS.ProcessEnv
	apiUrl?: string
	/** Override session detection (tests). */
	hasSession?: boolean
	/** Test seam for stored bootstrap/API token lookup. */
	loadApiToken?: NonNullable<
		Parameters<typeof resolveScopedApiToken>[0]
	>['loadApiToken']
}): boolean {
	if (hasExplicitTokenFlag(input.tokenValues)) return true
	if (!input.allowEnvWithoutLogin) return false
	if (
		!resolveScopedApiToken({
			tokenValues: input.tokenValues,
			env: input.env,
			apiUrl: input.apiUrl,
			loadApiToken: input.loadApiToken,
		})
	) {
		return false
	}
	const loggedIn =
		input.hasSession ?? loadCredentials(input.mcpUrl) != null
	return !loggedIn
}
