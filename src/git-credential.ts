import { createInterface } from 'node:readline'
import { defaultApiUrl, defaultMcpUrl } from './defaults.js'
import { loadStoredApiToken } from './api-token-store.js'
import { gitCredentialHostFromMcpUrl } from './setup-git.js'
import type { SecretBackend, StoreResolution } from './store.js'

export type GitCredentialAction = 'get' | 'store' | 'erase'

export type GitCredentialRequest = {
	protocol?: string
	host?: string
	path?: string
	username?: string
	password?: string
}

/**
 * Parse git credential helper stdin (`key=value` lines, blank line ends).
 * See `git help credential`.
 */
export function parseGitCredentialInput(text: string): GitCredentialRequest {
	const out: GitCredentialRequest = {}
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue
		const eq = line.indexOf('=')
		if (eq <= 0) continue
		const key = line.slice(0, eq)
		const value = line.slice(eq + 1)
		switch (key) {
			case 'protocol':
			case 'host':
			case 'path':
			case 'username':
			case 'password':
				out[key] = value
				break
			default:
				break
		}
	}
	return out
}

export function formatGitCredentialOutput(input: {
	username: string
	password: string
}): string {
	return `username=${input.username}\npassword=${input.password}\n`
}

export function isKodyGitHttpsHost(input: {
	protocol?: string
	host?: string
	expectedHost: string
}): boolean {
	if (input.protocol && input.protocol !== 'https') return false
	if (!input.host) return false
	return input.host.toLowerCase() === input.expectedHost.toLowerCase()
}

/**
 * Handle one git credential helper action.
 * - `get`: return stored `kody_at_…` for the configured Kody HTTPS host
 * - `store` / `erase`: no-op (token life is managed by `kody auth` / logout)
 */
export async function handleGitCredential(input: {
	action: GitCredentialAction
	request: GitCredentialRequest
	apiUrl?: string
	mcpUrl?: string
	backend?: SecretBackend
	resolution?: StoreResolution
}): Promise<string> {
	if (input.action === 'store' || input.action === 'erase') {
		return ''
	}
	if (input.action !== 'get') {
		throw new Error(`Unknown git-credential action "${String(input.action)}".`)
	}

	const expectedHost = gitCredentialHostFromMcpUrl(input.mcpUrl || defaultMcpUrl)
	if (
		!isKodyGitHttpsHost({
			protocol: input.request.protocol,
			host: input.request.host,
			expectedHost,
		})
	) {
		return ''
	}

	const apiUrl = input.apiUrl || defaultApiUrl
	const stored = loadStoredApiToken(apiUrl, input.backend, input.resolution)
	if (!stored?.token) {
		return ''
	}

	return formatGitCredentialOutput({
		username: 'x',
		password: stored.token,
	})
}

export function parseGitCredentialAction(argv: ReadonlyArray<string>): GitCredentialAction {
	const action = argv[0]
	if (action === 'get' || action === 'store' || action === 'erase') return action
	throw new Error(
		'Usage: kody git-credential <get|store|erase>\n(Git invokes this as a credential helper; see `kody auth setup-git`.)',
	)
}

/** Read stdin until EOF (git closes after the attribute block). */
export async function readGitCredentialStdin(
	stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
	if ('isTTY' in stdin && stdin.isTTY) return ''
	const chunks: Array<string> = []
	const rl = createInterface({ input: stdin, crlfDelay: Infinity })
	for await (const line of rl) {
		chunks.push(line)
	}
	return chunks.join('\n')
}
