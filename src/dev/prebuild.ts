/**
 * `kody.dev.prebuild`: a shell command `kody dev` runs from the package root
 * before every build, so generated assets (CSS, icons, data files) stay in
 * sync with the source without a second watcher process.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { apiTokenEnvVar } from '../defaults.js'

const outputTailLines = 20

export class PrebuildError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PrebuildError'
	}
}

export async function runPrebuild(input: {
	command: string
	cwd: string
	onSpawn?: (pid: number) => void
	onExit?: (pid: number) => void
	onLine?: (line: string, stream: 'stdout' | 'stderr') => void
}): Promise<void> {
	const env: NodeJS.ProcessEnv = { ...process.env, KODY_DEV: '1' }
	delete env[apiTokenEnvVar]
	const child = spawn('sh', ['-c', input.command], {
		cwd: input.cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (child.pid) input.onSpawn?.(child.pid)
	const tail: Array<string> = []
	const collect = (stream: 'stdout' | 'stderr') => (line: string) => {
		tail.push(line)
		if (tail.length > outputTailLines) tail.shift()
		input.onLine?.(line, stream)
	}
	createInterface({ input: child.stdout }).on('line', collect('stdout'))
	createInterface({ input: child.stderr }).on('line', collect('stderr'))
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.once('error', reject)
			child.once('close', (code, signal) => resolve({ code, signal }))
		},
	).finally(() => {
		if (child.pid) input.onExit?.(child.pid)
	})
	if (result.code === 0) return
	const how = result.signal ? `signal ${result.signal}` : `exit ${result.code}`
	throw new PrebuildError(
		[`kody.dev.prebuild failed (${how}): ${input.command}`, ...tail.map((line) => `  ${line}`)].join(
			'\n',
		),
	)
}
