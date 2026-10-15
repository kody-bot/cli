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
	/**
	 * Refresh fingerprints for the currently tracked paths without changing the
	 * path set or firing `onChange`. Call after intentional writers (e.g.
	 * `kody.dev.prebuild`) so their output is absorbed before a mid-build
	 * comparison.
	 */
	rebaseline: () => Promise<void>
	/**
	 * Replace the set of absolute paths the stat poll keeps an eye on.
	 * Re-baselines fingerprints so post-build mtime chatter does not echo a
	 * rebuild. Returns paths whose fingerprint changed since the previous
	 * baseline and are not listed in `ignoreChanges` (the files that triggered
	 * this build) — the caller should queue those for the next rebuild without
	 * going through `onChange` (which is debounced and would double-schedule
	 * when chokidar already saw the same mid-build edit).
	 */
	track: (
		paths: ReadonlyArray<string>,
		options?: { ignoreChanges?: ReadonlyArray<string> },
	) => Promise<ReadonlyArray<string>>
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
	// Init errors reject `ready` (awaited by start). Later errors are swallowed
	// so a transient watch glitch cannot crash the process.
	let readySettled = false
	const ready = new Promise<void>((resolve, reject) => {
		watcher.once('ready', () => {
			readySettled = true
			resolve()
		})
		watcher.on('error', (error) => {
			if (readySettled) return
			readySettled = true
			reject(error instanceof Error ? error : new Error(String(error)))
		})
	})

	type Fingerprint = string
	let tracked = new Map<string, Fingerprint | null>()
	let trackGeneration = 0
	let polling = false
	const poll = async () => {
		if (polling) return
		polling = true
		// Hold map + generation: track() bumps generation before it finishes
		// building the next baseline, so we abandon instead of comparing
		// post-build fingerprints against the pre-track map and echoing onChange.
		const map = tracked
		const generation = trackGeneration
		try {
			for (const [path, previous] of [...map]) {
				if (tracked !== map || generation !== trackGeneration) return
				const next = await fingerprint(path)
				if (tracked !== map || generation !== trackGeneration) return
				if (!map.has(path)) continue
				if (previous !== null && next !== previous) {
					map.set(path, next)
					if (tracked === map && generation === trackGeneration) input.onChange(path)
				} else if (previous === null) {
					map.set(path, next)
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
		rebaseline: async () => {
			const generation = ++trackGeneration
			const next = new Map<string, Fingerprint | null>()
			for (const path of tracked.keys()) {
				next.set(path, await fingerprint(path))
				if (generation !== trackGeneration) return
			}
			if (generation !== trackGeneration) return
			tracked = next
			trackGeneration++
		},
		track: async (paths, options) => {
			const ignoreChanges = new Set(options?.ignoreChanges ?? [])
			const generation = ++trackGeneration
			const changedDuringBuild: Array<string> = []
			const next = new Map<string, Fingerprint | null>()
			for (const path of paths) {
				if (ignored(path)) continue
				const current = await fingerprint(path)
				if (generation !== trackGeneration) return []
				const previous = tracked.get(path)
				if (
					previous !== undefined &&
					previous !== null &&
					current !== previous &&
					!ignoreChanges.has(path)
				) {
					changedDuringBuild.push(path)
				}
				next.set(path, current)
			}
			if (generation !== trackGeneration) return []
			tracked = next
			// Invalidate any poll that snapped the post-bump generation while
			// still iterating the pre-swap map (map-identity handles the rest).
			trackGeneration++
			return changedDuringBuild
		},
		close: async () => {
			clearInterval(timer)
			trackGeneration++
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
