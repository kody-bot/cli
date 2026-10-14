import * as esbuild from 'esbuild'
import { resolve } from 'node:path'

/**
 * Bundle a `--file` entry for local workerd the same way hosted execute /
 * publish resolves code: follow relative imports and npm packages, keep
 * `kody:*` external for package-graph + runtime binding, and leave `node:*`
 * external for workerd `nodejs_compat` (same as unbundled `--code`).
 */
export async function bundleLocalUserModule(modulePath: string): Promise<string> {
	const entry = resolve(modulePath)
	let result: esbuild.BuildResult
	try {
		result = await esbuild.build({
			absWorkingDir: process.cwd(),
			entryPoints: [entry],
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'neutral',
			target: 'esnext',
			logLevel: 'silent',
			packages: 'bundle',
			external: ['kody:*', 'node:*'],
		})
	} catch (error) {
		throw new Error(formatBundleError(modulePath, error))
	}
	const output = result.outputFiles?.[0]
	if (output === undefined) {
		throw new Error(
			`Could not bundle ${modulePath} for local execute: esbuild produced no output.`,
		)
	}
	if (result.errors.length > 0) {
		throw new Error(formatBundleError(modulePath, { errors: result.errors }))
	}
	return output.text
}

function formatBundleError(modulePath: string, error: unknown): string {
	const details = bundleErrorDetails(error)
	const header = `Could not bundle ${modulePath} for local execute.`
	const body = details.length > 0 ? `${header}\n${details}` : header
	// Only when the unresolved specifier itself is kody:@ (not a path that happens
	// to contain that substring).
	if (/Could not resolve ["']kody:@/i.test(details)) {
		return `${body}\nfix: Map the dependency in .kody/deps.json (or package.json#kody.localDeps), keep it in this package's exports, or log in so published package-graph can supply it.`
	}
	if (/Could not resolve|Cannot find module|ENOENT/i.test(body)) {
		return `${body}\nfix: Run \`npm install\` in the package directory (and any local deps), then retry.`
	}
	return body
}

function bundleErrorDetails(error: unknown): string {
	if (isEsbuildFailure(error)) {
		return error.errors
			.map((item) => item.text.trim())
			.filter((text) => text.length > 0)
			.join('\n')
	}
	if (error instanceof Error) return error.message
	return String(error)
}

function isEsbuildFailure(error: unknown): error is esbuild.BuildFailure {
	return (
		typeof error === 'object' &&
		error !== null &&
		'errors' in error &&
		Array.isArray((error as { errors: unknown }).errors)
	)
}
