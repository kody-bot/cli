import { loadStoredApiToken } from './api-token-store.js'
import {
	apiTokenEnvVar,
	defaultApiUrl,
	defaultMcpUrl,
} from './defaults.js'
import type { SecretBackend, StoreResolution } from './store.js'

/** Platform tracking for login OAuth as CapabilityProxy / package-graph Bearer. */
export const localExecuteOauthPlatformIssueUrl =
	'https://github.com/kentcdodds/kody/issues/2812'

export type ResolveScopedApiTokenInput = {
	tokenValues?: { token?: string }
	env?: NodeJS.ProcessEnv
	apiUrl?: string
	apiTokenBackend?: SecretBackend
	apiTokenResolution?: StoreResolution
	/** Test seam. */
	loadApiToken?: typeof loadStoredApiToken
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function tryParseUrl(value: string): URL | null {
	try {
		return new URL(value)
	} catch {
		return null
	}
}

function isWorkersDevHostname(hostname: string): boolean {
	return hostname.endsWith('.workers.dev')
}

/** Whether a login OAuth bearer may be sent to this API origin. */
export function isPairedApiUrl(
	apiUrl: string = defaultApiUrl,
	mcpUrl: string = defaultMcpUrl,
): boolean {
	const api = tryParseUrl(apiUrl)
	const mcp = tryParseUrl(mcpUrl)
	if (!api || !mcp) return false

	const apiIsLoopback = loopbackHosts.has(api.hostname.toLowerCase())
	const mcpIsLoopback = loopbackHosts.has(mcp.hostname.toLowerCase())
	if (apiIsLoopback && mcpIsLoopback) {
		return ['http:', 'https:'].includes(api.protocol) &&
			['http:', 'https:'].includes(mcp.protocol)
	}
	if (api.protocol !== 'https:' || mcp.protocol !== 'https:') return false
	const apiIsWorkersDev = isWorkersDevHostname(api.hostname)
	const mcpIsWorkersDev = isWorkersDevHostname(mcp.hostname)
	if (apiIsWorkersDev || mcpIsWorkersDev) {
		if (!apiIsWorkersDev || !mcpIsWorkersDev) return false
		const apiLabels = api.hostname.toLowerCase().split('.')
		const mcpLabels = mcp.hostname.toLowerCase().split('.')
		return (
			apiLabels.length === mcpLabels.length &&
			apiLabels.slice(1).join('.') === mcpLabels.slice(1).join('.') &&
			apiLabels[0] === `${mcpLabels[0]}-api`
		)
	}
	return api.hostname.toLowerCase() === `api.${mcp.hostname.toLowerCase()}`
}

export function expectedPairedApiOrigin(mcpUrl: string): string {
	const mcp = tryParseUrl(mcpUrl)
	if (!mcp) return 'a paired API origin'
	if (loopbackHosts.has(mcp.hostname.toLowerCase())) {
		return 'a loopback API origin'
	}
	const hostname = mcp.hostname.toLowerCase()
	if (isWorkersDevHostname(hostname)) {
		const labels = hostname.split('.')
		labels[0] = `${labels[0]}-api`
		return `https://${labels.join('.')}`
	}
	return `https://api.${hostname}`
}

/**
 * Scoped Open API / CapabilityProxy token (`kody_at_…`). Same source for
 * `execute --local`, token-only cloud execute, and Open API search/whoami.
 */
export function readApiToken(
	values: { token?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const token = (values.token ?? env[apiTokenEnvVar] ?? '').trim()
	return token.length > 0 ? token : null
}

/**
 * Resolve a scoped API token without falling back to `kody login` OAuth.
 * Priority: `--token` / `KODY_API_TOKEN` → stored bootstrap/API token.
 */
export function resolveScopedApiToken(
	input: ResolveScopedApiTokenInput = {},
): string | null {
	const token = readApiToken(input.tokenValues, input.env)
	if (token) return token
	const apiUrl = input.apiUrl || defaultApiUrl
	const loadApi = input.loadApiToken ?? loadStoredApiToken
	return loadApi(apiUrl, input.apiTokenBackend, input.apiTokenResolution)?.token ?? null
}

/** True when the bearer looks like a minted Open API token (not MCP OAuth). */
export function isScopedApiToken(token: string): boolean {
	return token.startsWith('kody_at_')
}

/**
 * How to mint a scoped token for CI/headless. Interactive agents on MCP should
 * prefer `cliCredentialBootstrap` → `auth bootstrap` instead.
 */
export function apiTokenMintInstructions(): string {
	return `For CI/headless only: mint with the Kody MCP \`api\` tool \`tokenCreate\` (include \`org:execute\` plus the capability scopes this command needs, e.g. \`package:execute\` / \`integration:read\`) and pass --token or set ${apiTokenEnvVar}.`
}

/** Preferred interactive path for agents already on Kody MCP (ADR 0056). */
export function cliBootstrapInstructions(): string {
	return `From MCP, call \`cliCredentialBootstrap\` (MCP \`api\` / \`kody.cliCredentialBootstrap\`), then run \`npx @kodycodes/cli auth bootstrap --code <kody_bc_…> --lifetime short\``
}

/** Token-only Open API paths (search / whoami / cloud token execute) with no token. */
export function missingApiTokenMessage(purpose: string): string {
	return `${purpose} needs a scoped Kody API token. ${cliBootstrapInstructions()}, or ${apiTokenMintInstructions()}`
}

/**
 * `execute --local` with neither env/`--token`, stored bootstrap token, nor
 * `kody login`. Prefer bootstrap (MCP) → login → tokenCreate (CI).
 */
export function missingLocalExecuteAuthMessage(
	purpose: string = 'execute --local',
): string {
	return `${purpose} needs auth. ${cliBootstrapInstructions()}; or run \`kody login\`; or for CI/headless, ${apiTokenMintInstructions()}`
}

/** Cloud search / whoami / execute when the process has neither a session nor a token. */
export function missingCliAuthMessage(): string {
	return `Not logged in, and no API token is set. ${cliBootstrapInstructions()}; or run \`kody login\` for browser OAuth (search, whoami, cloud execute, and login-backed \`execute --local\`); or for CI/headless, ${apiTokenMintInstructions()}`
}

/** 401 when CapabilityProxy rejected a non-`kody_at_` bearer (typically CLI OAuth). */
export function rejectedOauthBearerMessage(): string {
	return `Kody rejected the bearer from \`kody login\`: the Open API still accepts only scoped \`kody_at_…\` API tokens on CapabilityProxy / package-graph (not MCP OAuth). See ${localExecuteOauthPlatformIssueUrl}. Until that lands, ${apiTokenMintInstructions()}`
}

export function insufficientScopeMessage(input: {
	requiredScope?: string | null
	/** CapabilityProxy / package-graph: prefer bootstrap over tokenCreate. */
	includeLocalExecute?: boolean
}): string {
	const required = input.requiredScope ? ` The server requires "${input.requiredScope}".` : ''
	const mint = input.includeLocalExecute
		? `${cliBootstrapInstructions()} (lifetime short|long). ${apiTokenMintInstructions()}`
		: `${cliBootstrapInstructions()} (lifetime short|long). Or for CI/headless, mint with tokenCreate${
				input.requiredScope
					? ` that includes "${input.requiredScope}"`
					: ' that includes the required scope'
			}, then pass --token or set ${apiTokenEnvVar}.`
	return `Kody returned insufficient_scope.${required} ${mint}`
}

export function featureDisabledMessage(): string {
	return 'Kody returned feature_disabled: CapabilityProxy is not enabled for this Kody account (feature flag `local-execute`). `execute --local` and token-auth cloud execute both stop here; minting another token does not bypass the flag. Browser `kody login` can still run cloud execute over MCP.'
}

export function requireApiToken(
	values: { token?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
	purpose: string = 'this command',
	options: Omit<ResolveScopedApiTokenInput, 'tokenValues' | 'env'> = {},
): string {
	const token = resolveScopedApiToken({
		tokenValues: values,
		env,
		...options,
	})
	if (!token) throw new Error(missingApiTokenMessage(purpose))
	return token
}

/** True when the user passed `--token` (not only the env var). */
export function hasExplicitTokenFlag(values: { token?: string }): boolean {
	return typeof values.token === 'string' && values.token.trim().length > 0
}
