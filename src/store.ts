import {
	chmodSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Entry } from '@napi-rs/keyring'
import { defaultMcpUrl, keyringService } from './defaults.js'

export type StoredCredentials = {
	version: 1
	mcpUrl: string
	resource: string
	authorizationServerUrl: string
	clientId: string
	clientSecret?: string
	accessToken: string
	refreshToken?: string
	tokenType: string
	expiresAt?: number
	scope?: string
}

export type SecretBackend = {
	kind: 'keyring' | 'file'
	path?: string
	get(): string | null
	set(value: string): void
	delete(): boolean
}

/** Linux-only: require Secret Service. Ignored on macOS and Windows. */
export const secretServiceKeyringOptions = {
	linux: { store: 'secret-service' },
} as const

export type StoreResolution = {
	createKeyring?: (mcpUrl: string) => SecretBackend
	fileStorePath?: (mcpUrl: string) => string
}

export function accountForMcpUrl(mcpUrl: string): string {
	return `cli:${new URL(mcpUrl).origin}`
}

export function fileStorePath(
	mcpUrl: string,
	home: string = homedir(),
): string {
	const origin = new URL(mcpUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_')
	const base =
		process.platform === 'win32'
			? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'kody')
			: process.platform === 'darwin'
				? join(home, 'Library', 'Application Support', 'kody')
				: join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'kody')
	return join(base, `credentials-${origin}.json`)
}

export function createFileBackend(path: string): SecretBackend {
	return {
		kind: 'file',
		path,
		get() {
			try {
				return readFileSync(path, 'utf8')
			} catch {
				return null
			}
		},
		set(value: string) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
			writeFileSync(path, value, { mode: 0o600 })
			try {
				chmodSync(path, 0o600)
			} catch {
				// Windows cannot apply POSIX modes.
			}
		},
		delete() {
			try {
				unlinkSync(path)
				return true
			} catch {
				return false
			}
		},
	}
}

export function createKeyringBackend(mcpUrl: string): SecretBackend {
	const entry = new Entry(
		keyringService,
		accountForMcpUrl(mcpUrl),
		secretServiceKeyringOptions,
	)
	return {
		kind: 'keyring',
		get() {
			try {
				return entry.getPassword()
			} catch {
				return null
			}
		},
		set(value: string) {
			entry.setPassword(value)
		},
		delete() {
			try {
				return entry.deleteCredential()
			} catch {
				return false
			}
		},
	}
}

function fileBackendFor(
	mcpUrl: string,
	resolution?: StoreResolution,
): SecretBackend {
	const path = resolution?.fileStorePath?.(mcpUrl) ?? fileStorePath(mcpUrl)
	return createFileBackend(path)
}

export function resolveBackend(
	mcpUrl: string,
	preferred?: SecretBackend,
	resolution?: StoreResolution,
): SecretBackend {
	if (preferred) return preferred
	try {
		return (resolution?.createKeyring ?? createKeyringBackend)(mcpUrl)
	} catch {
		return fileBackendFor(mcpUrl, resolution)
	}
}

export function parseCredentials(raw: string): StoredCredentials {
	const parsed = JSON.parse(raw) as StoredCredentials
	if (parsed.version !== 1 || !parsed.accessToken || !parsed.clientId) {
		throw new Error('Stored Kody credentials are invalid. Run `kody login`.')
	}
	return parsed
}

function readParsed(store: SecretBackend): StoredCredentials | null {
	const raw = store.get()
	if (!raw) return null
	return parseCredentials(raw)
}

export function loadCredentials(
	mcpUrl: string = defaultMcpUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): StoredCredentials | null {
	const store = resolveBackend(mcpUrl, backend, resolution)
	try {
		const loaded = readParsed(store)
		if (loaded) return loaded
	} catch (error) {
		if (!(store.kind === 'keyring' && !backend)) throw error
	}
	if (store.kind === 'keyring' && !backend) {
		return readParsed(fileBackendFor(mcpUrl, resolution))
	}
	return null
}

export function saveCredentials(
	credentials: StoredCredentials,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): { backend: SecretBackend } {
	const store = resolveBackend(credentials.mcpUrl, backend, resolution)
	try {
		store.set(JSON.stringify(credentials))
		return { backend: store }
	} catch (error) {
		if (store.kind === 'keyring' && !backend) {
			const fallback = fileBackendFor(credentials.mcpUrl, resolution)
			fallback.set(JSON.stringify(credentials))
			return { backend: fallback }
		}
		throw error
	}
}

export function deleteCredentials(
	mcpUrl: string = defaultMcpUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): { deleted: boolean; backend: SecretBackend } {
	const store = resolveBackend(mcpUrl, backend, resolution)
	let deleted = false
	try {
		deleted = store.delete()
	} catch {
		deleted = false
	}
	if (store.kind === 'keyring' && !backend) {
		const file = fileBackendFor(mcpUrl, resolution)
		deleted = file.delete() || deleted
	}
	return { deleted, backend: store }
}
