import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCommand } from '../src/cli.js'
import { onboardingUrl } from '../src/defaults.js'
import {
	formatInstallReport,
	noRunningAgentsMessage,
	runInstall,
} from '../src/install.js'
import {
	buildOnboardingContinuationPrompt,
	webClientsOnboardingNote,
} from '../src/onboarding-prompt.js'

const mcpUrl = 'https://kody.codes/mcp'

test('resolveCommand maps install flags', () => {
	const parsed = resolveCommand(['install', '--clients', 'cursor,goose', '--yes'])
	assert.equal(parsed.command, 'install')
	assert.equal(parsed.values.clients, 'cursor,goose')
	assert.equal(parsed.values.yes, true)
})

test('runInstall writes Cursor config for an explicit client', async () => {
	const upserts: Array<{ agent: string; name: string; url?: string; local?: boolean }> = []
	const opened: Array<string> = []
	let output = ''
	const result = await runInstall(
		{ mcpUrl, clients: 'cursor' },
		{
			stdout: (text) => {
				output += text
			},
			home: '/home/me',
			cwd: '/proj',
			isTTY: false,
			listProcesses: async () => [],
			runtime: {
				openUrl: async (url) => {
					opened.push(url)
					return true
				},
				upsertServer: (agent, name, config, options) => {
					upserts.push({ agent, name, url: config.url, local: options?.local })
					return { success: true, path: '/home/me/.cursor/mcp.json' }
				},
			},
		},
	)
	assert.equal(result.code, 0)
	assert.equal(result.results[0]?.status, 'wrote')
	assert.deepEqual(upserts, [
		{ agent: 'cursor', name: 'kody', url: mcpUrl, local: false },
	])
	assert.equal(opened.length, 1)
	assert.match(opened[0] ?? '', /^cursor:\/\//)
	assert.match(output, /Paste this into your agent/)
	assert.match(output, /kody\.codes\/onboarding/)
})

test('runInstall does not list web clients when nothing local is running', async () => {
	let output = ''
	const result = await runInstall(
		{ mcpUrl },
		{
			stdout: (text) => {
				output += text
			},
			isTTY: false,
			listProcesses: async () => [{ name: 'Safari' }, { name: 'chrome' }],
		},
	)
	assert.equal(result.code, 1)
	assert.equal(result.results.length, 0)
	assert.match(output, /No local MCP agents are running/)
	assert.match(output, /ChatGPT, Claude\.ai, Grok/)
	assert.doesNotMatch(output, /chatgpt/)
})

test('runInstall writes leftover VS Code Insiders config without add-mcp', async () => {
	const files = new Map<string, string>()
	const upserts: Array<string> = []
	const result = await runInstall(
		{ mcpUrl, clients: 'vscode-insiders' },
		{
			stdout: () => undefined,
			home: '/home/me',
			cwd: '/proj',
			isTTY: false,
			listProcesses: async () => [],
			runtime: {
				platform: 'linux',
				openUrl: async () => true,
				upsertServer: (agent) => {
					upserts.push(agent)
					return { success: true, path: '/unused' }
				},
				readFile: async (path) => files.get(path) ?? null,
				writeFile: async (path, body) => {
					files.set(path, body)
				},
				mkdir: async () => undefined,
			},
		},
	)
	assert.equal(result.results[0]?.status, 'wrote')
	assert.deepEqual(upserts, [])
	assert.deepEqual(
		JSON.parse(files.get('/home/me/.config/Code - Insiders/User/mcp.json') ?? '{}'),
		{ servers: { kody: { type: 'http', url: mcpUrl } } },
	)
})

test('Claude Desktop stays instruction-only', async () => {
	const files = new Map<string, string>()
	const apps: Array<string> = []
	const result = await runInstall(
		{ mcpUrl, clients: 'claude-desktop' },
		{
			stdout: () => undefined,
			home: '/home/me',
			isTTY: false,
			listProcesses: async () => [],
			runtime: {
				openApp: async (name) => {
					apps.push(name)
					return true
				},
				writeFile: async (path, body) => {
					files.set(path, body)
				},
				mkdir: async () => undefined,
			},
		},
	)
	assert.equal(result.results[0]?.status, 'manual')
	assert.equal(apps[0], 'Claude')
	assert.equal(files.size, 0)
	assert.match(result.results[0]?.instructions.join('\n') ?? '', /Connectors/)
	assert.match(
		result.results[0]?.instructions.join('\n') ?? '',
		/claude_desktop_config\.json/,
	)
})

test('onboarding prompt and help note stay copyable', () => {
	assert.match(buildOnboardingContinuationPrompt(), /Kody is connected/)
	assert.match(buildOnboardingContinuationPrompt(), /coding_guide_get/)
	assert.equal(onboardingUrl(mcpUrl), 'https://kody.codes/onboarding')
	assert.equal(
		webClientsOnboardingNote(mcpUrl),
		'For web-based clients (ChatGPT, Claude.ai, Grok), see https://kody.codes/onboarding',
	)
	assert.match(noRunningAgentsMessage(mcpUrl), /kody\.codes\/onboarding/)
	assert.match(
		formatInstallReport({
			mcpUrl,
			results: [
				{
					id: 'cursor',
					label: 'Cursor',
					status: 'wrote',
					path: '/home/me/.cursor/mcp.json',
					instructions: ['Approve Kody in the browser when the client starts OAuth.'],
				},
			],
		}),
		/Paste this into your agent to continue onboarding/,
	)
})
