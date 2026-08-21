import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const pathValue = env.PATH ?? env.Path
	if (!pathValue) return undefined
	const extensions =
		process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
	for (const directory of pathValue.split(delimiter)) {
		for (const extension of extensions) {
			const candidate = join(directory, `${command}${extension}`)
			try {
				accessSync(candidate, constants.X_OK)
				return candidate
			} catch {
				// keep looking
			}
		}
	}
	return undefined
}
