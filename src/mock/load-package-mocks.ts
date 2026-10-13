/**
 * Load optional `<packageRoot>/.kody/mocks.ts` for `--target mock` outbound
 * fetch mocking. Missing file → no handlers (packages without mocks keep
 * native workerd fetch). Never imported into published package bundles.
 */

import * as esbuild from 'esbuild'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RequestHandler } from 'msw'
import { StructuredCliError } from '../structured-error.js'

const requireFromCli = createRequire(import.meta.url)

export const packageMocksRelativePath = '.kody/mocks.ts'

export type LoadedPackageMocks = {
	path: string
	handlers: Array<RequestHandler>
}

export async function resolvePackageMocksPath(
	packageRoot: string,
): Promise<string | null> {
	const path = join(packageRoot, packageMocksRelativePath)
	try {
		await access(path)
		return path
	} catch {
		return null
	}
}

/**
 * Bundle and evaluate `.kody/mocks.ts`. Expects `export const handlers = […]`
 * (MSW `http.*` handlers) or a default export of that array.
 */
export async function loadPackageMocks(
	packageRoot: string,
): Promise<LoadedPackageMocks | null> {
	const path = await resolvePackageMocksPath(packageRoot)
	if (!path) return null

	const workDir = await mkdtemp(join(tmpdir(), 'kody-mocks-'))
	const outfile = join(workDir, 'mocks.mjs')
	try {
		const mswHref = pathToFileURL(requireFromCli.resolve('msw')).href
		let result: esbuild.BuildResult
		try {
			result = await esbuild.build({
				entryPoints: [path],
				bundle: true,
				platform: 'node',
				format: 'esm',
				target: 'node22',
				outfile,
				write: true,
				logLevel: 'silent',
				// Leave MSW external; rewrite the import to the CLI-resolved absolute URL.
				external: ['msw', 'msw/*'],
			})
		} catch (error) {
			const messages =
				error && typeof error === 'object' && 'errors' in error
					? (error as esbuild.BuildFailure).errors.map((item) => item.text)
					: [error instanceof Error ? error.message : String(error)]
			throw new StructuredCliError({
				code: 'bundle_failed',
				message: `Could not bundle ${packageMocksRelativePath} for --target mock.`,
				target: 'mock',
				where: path,
				fix: 'Fix TypeScript/syntax errors in .kody/mocks.ts and retry. Import handlers from `msw` (provided by @kodycodes/cli).',
				details: { errors: messages },
			})
		}
		if (result.errors.length > 0) {
			throw new StructuredCliError({
				code: 'bundle_failed',
				message: `Could not bundle ${packageMocksRelativePath} for --target mock.`,
				target: 'mock',
				where: path,
				fix: 'Fix TypeScript/syntax errors in .kody/mocks.ts and retry.',
				details: {
					errors: result.errors.map((error) => error.text),
				},
			})
		}
		const bundled = await readFile(outfile, 'utf8')
		const rewritten = bundled.replace(
			/(from\s*|import\s*\(|require\s*\()\s*(['"])msw\2/g,
			(_match, prefix: string, quote: string) =>
				`${prefix}${quote}${mswHref}${quote}`,
		)
		await writeFile(outfile, rewritten)
		const mod = (await import(pathToFileURL(outfile).href)) as {
			handlers?: unknown
			default?: unknown
		}
		const raw = mod.handlers ?? mod.default
		if (!Array.isArray(raw)) {
			throw new StructuredCliError({
				code: 'package_manifest_invalid',
				message: `${packageMocksRelativePath} must export \`handlers\` (or default) as an array of MSW http handlers.`,
				target: 'mock',
				where: path,
				fix: `export const handlers = [http.get('https://api.example.com/…', () => HttpResponse.json({ ok: true }))]`,
			})
		}
		return { path, handlers: raw as Array<RequestHandler> }
	} catch (error) {
		if (error instanceof StructuredCliError) throw error
		throw new StructuredCliError({
			code: 'bundle_failed',
			message: `Could not load ${packageMocksRelativePath}.`,
			target: 'mock',
			where: path,
			fix: 'Ensure the file exports MSW handlers and that `msw` is resolvable from the package (or rely on the CLI’s dependency).',
			details: {
				cause: error instanceof Error ? error.message : String(error),
			},
		})
	} finally {
		await rm(workDir, { recursive: true, force: true })
	}
}

/** Write a tiny helper so tests can assert the relative path without importing fs. */
export function packageMocksPathFor(packageRoot: string): string {
	return join(packageRoot, packageMocksRelativePath)
}
