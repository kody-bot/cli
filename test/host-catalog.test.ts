import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getAgentTypes } from 'add-mcp'
import { addMcpAgentByHostId } from '../src/add-mcp-install.js'
import { detectRunningHosts } from '../src/detect-running-hosts.js'
import {
	buildCursorInstallUrl,
	buildGooseInstallUrl,
	hostConfigPath,
	parseHostIds,
} from '../src/host-catalog.js'

test('parseHostIds rejects web clients and accepts local aliases', () => {
	assert.deepEqual(parseHostIds('cursor,vscode'), ['cursor', 'vscode'])
	assert.deepEqual(parseHostIds('github-copilot-cli,gemini'), ['copilot-cli', 'gemini-cli'])
	assert.throws(() => parseHostIds('chatgpt'), /web client/)
	assert.throws(() => parseHostIds('grok'), /grok-build/)
	assert.throws(() => parseHostIds('claude.ai'), /web client/)
})

test('detectRunningHosts only matches local process names', () => {
	const detected = detectRunningHosts([
		{ name: 'Cursor', cmd: '/Applications/Cursor.app/Contents/MacOS/Cursor' },
		{ name: 'Claude', cmd: '/Applications/Claude.app/Contents/MacOS/Claude' },
		{ name: 'claude', cmd: '/usr/local/bin/claude' },
		{ name: 'Code Helper', cmd: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app' },
		{ name: 'Goose', cmd: '/Applications/Goose.app/Contents/MacOS/Goose' },
		{ name: 'grok', cmd: '/usr/local/bin/grok' },
		{ name: 'Safari', cmd: '/Applications/Safari.app/Contents/MacOS/Safari' },
		{ name: 'chrome', cmd: 'Google Chrome claude.ai chatgpt.com grok.com' },
	])
	assert.deepEqual(
		detected.map((host) => host.id).sort(),
		['claude-code', 'claude-desktop', 'cursor', 'goose', 'grok-build', 'vscode'],
	)
})

test('Cursor is not classified as VS Code', () => {
	const detected = detectRunningHosts([
		{ name: 'Cursor Helper', cmd: '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app' },
	])
	assert.deepEqual(
		detected.map((host) => host.id),
		['cursor'],
	)
})

test('hostConfigPath uses user-level files by default', () => {
	assert.equal(
		hostConfigPath({ id: 'cursor', home: '/home/me', cwd: '/proj', project: false }),
		'/home/me/.cursor/mcp.json',
	)
	assert.equal(
		hostConfigPath({
			id: 'vscode',
			home: '/home/me',
			cwd: '/proj',
			project: false,
			platform: 'linux',
		}),
		'/home/me/.config/Code/User/mcp.json',
	)
	assert.equal(
		hostConfigPath({
			id: 'claude-desktop',
			home: '/home/me',
			cwd: '/proj',
			project: false,
		}),
		null,
	)
	assert.equal(
		hostConfigPath({ id: 'goose', home: '/home/me', cwd: '/proj', project: true }),
		null,
	)
	assert.equal(
		hostConfigPath({ id: 'cursor', home: '/home/me', cwd: '/proj', project: true }),
		'/proj/.cursor/mcp.json',
	)
})

test('install deeplinks encode the MCP URL', () => {
	assert.match(buildCursorInstallUrl('https://kody.codes/mcp'), /^cursor:\/\//)
	assert.match(buildGooseInstallUrl('https://kody.codes/mcp'), /streamable_http/)
})

test('every add-mcp agent is mapped or intentionally skipped', () => {
	const skipped = new Set<string>(['claude-desktop'])
	const mapped = new Set<string>(Object.values(addMcpAgentByHostId))
	for (const agent of getAgentTypes()) {
		if (skipped.has(agent)) continue
		assert.equal(mapped.has(agent), true, `missing add-mcp mapping for ${agent}`)
	}
})
