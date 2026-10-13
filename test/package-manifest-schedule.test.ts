import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadPackageManifest } from '../src/package-manifest.js'

test('loadPackageManifest accepts object-form job schedules like prod', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'kody-sched-'))
	try {
		await mkdir(join(dir, 'jobs'), { recursive: true })
		await writeFile(
			join(dir, 'package.json'),
			JSON.stringify({
				name: '@local/sched-pkg',
				private: true,
				type: 'module',
				exports: { '.': './index.ts' },
				kody: {
					id: 'sched-pkg',
					jobs: {
						'daily-check': {
							entry: './jobs/daily.ts',
							schedule: { type: 'cron', expression: '0 9 * * *' },
							timezone: 'America/Denver',
						},
						hourly: {
							entry: './jobs/hourly.ts',
							schedule: '0 * * * *',
						},
					},
				},
			}),
		)
		await writeFile(join(dir, 'index.ts'), 'export default async () => ({})\n')
		await writeFile(join(dir, 'jobs/daily.ts'), 'export default async () => ({})\n')
		await writeFile(join(dir, 'jobs/hourly.ts'), 'export default async () => ({})\n')

		const manifest = await loadPackageManifest(dir)
		assert.equal(manifest.jobs['daily-check']?.schedule, '0 9 * * *')
		assert.deepEqual(manifest.jobs['daily-check']?.scheduleRaw, {
			type: 'cron',
			expression: '0 9 * * *',
		})
		assert.equal(manifest.jobs['daily-check']?.timezone, 'America/Denver')
		assert.equal(manifest.jobs.hourly?.schedule, '0 * * * *')
		assert.equal(manifest.jobs.hourly?.scheduleRaw, '0 * * * *')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('loadPackageManifest rejects invalid job schedules with a clear fix', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'kody-sched-bad-'))
	try {
		await writeFile(
			join(dir, 'package.json'),
			JSON.stringify({
				name: '@local/bad-sched',
				private: true,
				kody: {
					id: 'bad-sched',
					jobs: {
						broken: { entry: './job.ts', schedule: { type: 'cron' } },
					},
				},
			}),
		)
		await assert.rejects(
			() => loadPackageManifest(dir),
			(error: unknown) => {
				assert.ok(error instanceof Error)
				assert.match(error.message, /schedule string or \{ type, expression \}/)
				return true
			},
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
