import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const skillRelativePath = 'skills/kody/SKILL.md'

export function bundledSkillPath(): string {
	return join(fileURLToPath(new URL('../', import.meta.url)), skillRelativePath)
}

export function userSkillTargets(home: string = homedir()): Array<{
	host: string
	path: string
}> {
	return [
		{ host: 'Claude Code', path: join(home, '.claude', 'skills', 'kody', 'SKILL.md') },
		{ host: 'Cursor', path: join(home, '.cursor', 'skills', 'kody', 'SKILL.md') },
		{ host: 'Agents', path: join(home, '.agents', 'skills', 'kody', 'SKILL.md') },
	]
}

export function projectSkillTargets(cwd: string = process.cwd()): Array<{
	host: string
	path: string
}> {
	return [
		{ host: 'Agents', path: join(cwd, '.agents', 'skills', 'kody', 'SKILL.md') },
		{ host: 'Cursor', path: join(cwd, '.cursor', 'skills', 'kody', 'SKILL.md') },
		{ host: 'Claude Code', path: join(cwd, '.claude', 'skills', 'kody', 'SKILL.md') },
	]
}

export async function installSkill(input: {
	project?: boolean
	cwd?: string
	home?: string
	sourcePath?: string
}): Promise<Array<{ host: string; path: string }>> {
	const source = input.sourcePath ?? bundledSkillPath()
	const body = await readFile(source, 'utf8')
	const targets = input.project
		? projectSkillTargets(input.cwd)
		: userSkillTargets(input.home)
	for (const target of targets) {
		await mkdir(dirname(target.path), { recursive: true })
		await writeFile(target.path, body, 'utf8')
	}
	return targets
}
