/**
 * File watching for `kody dev`. chokidar watches the package tree (it re-arms
 * per-directory watchers when editors or `sed -i` / `cp` replace a file with a
 * new inode). A low-frequency stat poll over the files in the current bundle
 * graph backs it up, so a missed event can never leave a stale bundle serving.
 */

import { watch, type FSWatcher } from 'chokidar'
import { stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'

const defaultPollIntervalMs = 1000

export type DevWatcher = {
	ready: Promise<void>
	/** Replace the set of absolute paths the stat poll keeps an eye on. */
	track: (paths: ReadonlyArray<string>) => void
	close: () => Promise<void>
}

export function createDevWatcher(input: {
	root: string
	onChange: (path: string) => void
	/** Extra root-relative path prefixes to ignore. */
	ignore?: ReadonlyArray<string>
	pollIntervalMs?: number
}): DevWatcher {
	const ignorePrefixes = (input.ignore ?? []).map(normalizePrefix).filter(Boolean)
	const ignored = (path: string) =>
		shouldIgnoreWatchPath(relative(input.root, path), ignorePrefixes)

	const watcher: FSWatcher = watch(input.root, {
		ignoreInitial: true,
		ignored,
		atomic: true,
	})
	watcher.on('all', (_event, path) => {
		if (!ignored(path)) input.onChange(path)
	})
	watcher.on('error', () => {})
	const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()))

	type Fingerprint = string
	let tracked = new Map<string, Fingerprint | null>()
	let polling = false
	const poll = async () => {
		if (polling) return
		polling = true
		try {
			for (const [path, previous] of tracked) {
				const next = await fingerprint(path)
				if (!tracked.has(path)) continue
				if (previous !== null && next !== previous) {
					tracked.set(path, next)
					input.onChange(path)
				} else if (previous === null) {
					tracked.set(path, next)
				}
			}
		} finally {
			polling = false
		}
	}
	const timer = setInterval(() => void poll(), input.pollIntervalMs ?? defaultPollIntervalMs)
	timer.unref()

	return {
		ready,
		track: (paths) => {
			const next = new Map<string, Fingerprint | null>()
			for (const path of paths) {
				if (ignored(path)) continue
				next.set(path, tracked.get(path) ?? null)
			}
			tracked = next
			void poll()
		},
		close: async () => {
			clearInterval(timer)
			tracked = new Map()
			await watcher.close()
		},
	}
}

async function fingerprint(path: string): Promise<string> {
	try {
		const info = await stat(path)
		return `${info.ino}:${info.size}:${info.mtimeMs}`
	} catch {
		return 'missing'
	}
}

function normalizePrefix(prefix: string): string {
	return prefix.replace(/^\.\//, '').replace(/\/+$/, '').split('/').join(sep)
}

export function shouldIgnoreWatchPath(
	relativePath: string,
	ignorePrefixes: ReadonlyArray<string> = [],
): boolean {
	if (!relativePath || relativePath === '.') return false
	if (relativePath.startsWith('..')) return true
	const segments = relativePath.split(sep)
	if (segments.some((segment) => segment === 'node_modules' || segment.startsWith('.'))) {
		return true
	}
	if (relativePath.endsWith('.map')) return true
	return ignorePrefixes.some(
		(prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}${sep}`),
	)
}
