/**
 * Scratch storage for `--target mock`, keyed by the active content-addressed
 * session directory under the user cache. Reset with `--reset-storage`.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { userCacheDir } from '../workerd-binary.js'

export type MockStorageBucket = {
	/** Arbitrary JSON-serializable rows keyed by string id. */
	rows: Record<string, unknown>
}

export type MockSessionState = {
	version: 1
	sessionId: string
	createdAt: string
	updatedAt: string
	/** packageId → bucket */
	packageStorage: Record<string, MockStorageBucket>
	/** Fake / local credential metadata only — never real secret values from prod. */
	credentials: Record<
		string,
		{
			id: string
			name: string
			kind: 'secret' | 'oauth'
			/** Host allow-list for credential().fetch (ADR 0068 client shape). */
			hosts: Array<string>
			scope?: 'personal' | 'org'
			/** Placeholder value used only inside the mock. */
			mockValue: string
		}
	>
	/** Soft catalog entries surfaced by mock search. */
	searchCatalog: Array<{
		type: string
		id: string
		title: string
		description: string
	}>
}

const mockStateFile = 'state.json'

export function mockSessionRoot(
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(userCacheDir(env), 'mock-sessions', sessionId)
}

export function defaultMockSessionId(env: NodeJS.ProcessEnv = process.env): string {
	return env.KODY_MOCK_SESSION_ID?.trim() || 'default'
}

export async function loadMockSession(input: {
	sessionId?: string
	env?: NodeJS.ProcessEnv
	reset?: boolean
}): Promise<MockSessionState> {
	const env = input.env ?? process.env
	const sessionId = input.sessionId ?? defaultMockSessionId(env)
	const root = mockSessionRoot(sessionId, env)
	if (input.reset) {
		await rm(root, { recursive: true, force: true })
	}
	await mkdir(root, { recursive: true })
	const path = join(root, mockStateFile)
	try {
		const raw = JSON.parse(await readFile(path, 'utf8')) as MockSessionState
		if (raw?.version === 1 && raw.sessionId === sessionId) {
			return normalizeMockSessionCredentials(raw)
		}
	} catch {
		// miss → create
	}
	const now = new Date().toISOString()
	const fresh: MockSessionState = {
		version: 1,
		sessionId,
		createdAt: now,
		updatedAt: now,
		packageStorage: {},
		credentials: {
			MOCK_SECRET: {
				id: 'cred_mock_secret',
				name: 'MOCK_SECRET',
				kind: 'secret',
				hosts: ['example.com'],
				scope: 'personal',
				mockValue: 'mock-secret-value',
			},
		},
		searchCatalog: [
			{
				type: 'guide',
				id: 'local_execute',
				title: 'Local CLI execute',
				description: 'Prefer @kodycodes/cli execute --local when Node ≥22.',
			},
			{
				type: 'capability',
				id: 'metaGetCurrentUser',
				title: 'metaGetCurrentUser',
				description: 'Return the current authenticated user and org binding.',
			},
			{
				type: 'guide',
				id: 'package_apps',
				title: 'Package apps',
				description: 'Hosted Worker apps on *.kody.run; use kody dev for local.',
			},
		],
	}
	await persistMockSession(fresh, env)
	return fresh
}

export async function persistMockSession(
	state: MockSessionState,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	state.updatedAt = new Date().toISOString()
	const root = mockSessionRoot(state.sessionId, env)
	await mkdir(root, { recursive: true })
	await writeFile(join(root, mockStateFile), `${JSON.stringify(state, null, 2)}\n`)
}

/** Backfill hosts/scope on older mock session files so credential() stays iterable. */
function normalizeMockSessionCredentials(state: MockSessionState): MockSessionState {
	const credentials: MockSessionState['credentials'] = {}
	for (const [key, cred] of Object.entries(state.credentials ?? {})) {
		credentials[key] = {
			...cred,
			hosts: Array.isArray(cred.hosts) && cred.hosts.length > 0 ? cred.hosts : ['example.com'],
			scope: cred.scope === 'org' ? 'org' : 'personal',
		}
	}
	if (!credentials.MOCK_SECRET) {
		credentials.MOCK_SECRET = {
			id: 'cred_mock_secret',
			name: 'MOCK_SECRET',
			kind: 'secret',
			hosts: ['example.com'],
			scope: 'personal',
			mockValue: 'mock-secret-value',
		}
	}
	state.credentials = credentials
	return state
}

export function packageStorageGet(
	state: MockSessionState,
	packageId: string,
	key: string,
): unknown {
	return state.packageStorage[packageId]?.rows[key]
}

export function packageStorageSet(
	state: MockSessionState,
	packageId: string,
	key: string,
	value: unknown,
): void {
	const bucket = (state.packageStorage[packageId] ??= { rows: {} })
	bucket.rows[key] = value
}

export function packageStorageDelete(
	state: MockSessionState,
	packageId: string,
	key: string,
): boolean {
	const bucket = state.packageStorage[packageId]
	if (!bucket || !(key in bucket.rows)) return false
	delete bucket.rows[key]
	return true
}

export function packageStorageList(
	state: MockSessionState,
	packageId: string,
): Array<{ key: string; value: unknown }> {
	const rows = state.packageStorage[packageId]?.rows ?? {}
	return Object.entries(rows).map(([key, value]) => ({ key, value }))
}
