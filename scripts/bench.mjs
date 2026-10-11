#!/usr/bin/env node
// CLI startup and local-execute benchmark. Runs the built dist/bin.js against
// a loopback stand-in for api.kody.codes so the numbers isolate CLI-side work
// (Node startup, module load, workerd spawn) from network latency.
//
//   npm run build && node scripts/bench.mjs [--runs 20] [--json out.json] [--budget budgets.json]
//
// With --budget, exits 1 when any scenario's p50 exceeds its budget. Budgets are
// milliseconds over the 'node baseline' p50 of the same run, so they hold on
// slow CI runners as well as on a laptop.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bin = join(here, '..', 'dist', 'bin.js')
const { values } = parseArgs({
	options: {
		runs: { type: 'string', default: '20' },
		json: { type: 'string' },
		budget: { type: 'string' },
	},
})
const runs = Number(values.runs)

const shimName = '.__kody_virtual__/runtime.js'
const server = createServer(async (request, response) => {
	let raw = ''
	for await (const chunk of request) raw += chunk
	const send = (status, payload) => {
		response.writeHead(status, { 'content-type': 'application/json' })
		response.end(JSON.stringify(payload))
	}
	if (request.url === '/v1/capability-proxy/session') {
		return send(200, { scopes: ['org:execute'], expiresAt: null })
	}
	if (request.url === '/v1/capability-proxy/call') {
		return send(200, { result: { ok: true } })
	}
	if (request.url === '/v1/local-execute/package-graph') {
		const { imports = [] } = JSON.parse(raw)
		const modules = imports.map((name) => ({
			name,
			esModule: 'export default function greet(name) { return { hello: name } }\n',
		}))
		return send(200, {
			imports,
			warnings: [],
			modules: [...modules, { name: shimName, esModule: 'export {}\n' }],
		})
	}
	send(404, { error: { code: 'not_found', message: request.url } })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${server.address().port}`

const executeFlags = ['execute', '--local', '--api-url', apiUrl, '--token', 'kody_at_bench']
const scenarios = {
	'node baseline': { command: process.execPath, args: ['-e', ''] },
	'--version': { args: ['--version'] },
	status: { args: ['status'], env: { XDG_CONFIG_HOME: '/nonexistent' } },
	'execute --local empty': {
		args: [...executeFlags, '--code', 'export default async function main() { return null }'],
	},
	'execute --local kody:@ import': {
		args: [
			...executeFlags,
			'--code',
			'import greet from "kody:@bench/pkg/greet"\nexport default async function main() { return greet("x") }',
		],
	},
	'execute --local runtime call': {
		args: [
			...executeFlags,
			'--code',
			'import { kody } from "kody:runtime"\nexport default async function main() { return await kody.metaGetCurrentUser({}) }',
		],
	},
}

// Spawn asynchronously so the loopback API above keeps serving while the CLI runs.
function run(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
		let stderr = ''
		child.stderr.setEncoding('utf8')
		child.stderr.on('data', (chunk) => (stderr += chunk))
		child.on('error', reject)
		child.on('close', (status) => resolve({ status, stderr }))
	})
}

function percentile(sorted, q) {
	const k = (sorted.length - 1) * q
	const lower = Math.floor(k)
	const upper = Math.min(lower + 1, sorted.length - 1)
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (k - lower)
}

const results = {}
for (const [name, scenario] of Object.entries(scenarios)) {
	const command = scenario.command ?? process.execPath
	const args = scenario.command ? scenario.args : [bin, ...scenario.args]
	const env = { ...process.env, ...scenario.env }
	const samples = []
	for (let i = 0; i < runs; i++) {
		const started = performance.now()
		const result = await run(command, args, env)
		const elapsed = performance.now() - started
		if (name !== 'status' && result.status !== 0) {
			throw new Error(`${name} exited ${result.status}: ${result.stderr}`)
		}
		samples.push(elapsed)
	}
	samples.sort((a, b) => a - b)
	results[name] = {
		runs,
		p50: Math.round(percentile(samples, 0.5) * 10) / 10,
		p95: Math.round(percentile(samples, 0.95) * 10) / 10,
		min: Math.round(samples[0] * 10) / 10,
	}
}
server.close()

const budgets = values.budget ? JSON.parse(readFileSync(values.budget, 'utf8')) : {}
const baseline = results['node baseline'].p50
const lines = [
	'| scenario | p50 ms | p95 ms | min ms | over baseline | budget |',
	'|---|---:|---:|---:|---:|---:|',
]
let failed = false
for (const [name, stats] of Object.entries(results)) {
	const budget = budgets[name]
	const overBaseline = Math.round((stats.p50 - baseline) * 10) / 10
	const over = budget !== undefined && overBaseline > budget
	if (over) failed = true
	lines.push(
		`| ${name} | ${stats.p50} | ${stats.p95} | ${stats.min} | ${overBaseline} | ${budget ?? ''}${over ? ' (over)' : ''} |`,
	)
}
const table = lines.join('\n')
console.log(`Node ${process.version}, ${runs} runs each\n\n${table}`)
if (values.json) writeFileSync(values.json, JSON.stringify({ node: process.version, results }, null, 2))
if (process.env.GITHUB_STEP_SUMMARY) {
	writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## CLI benchmark (Node ${process.version})\n\n${table}\n`, { flag: 'a' })
}
if (failed) {
	console.error('\nBenchmark budget exceeded.')
	process.exit(1)
}
