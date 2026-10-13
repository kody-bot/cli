import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Running package version from this package's `package.json` (same source for
 * `kody --version` and the `kody --help` header). Falls back only when the
 * adjacent package.json cannot be read (broken installs).
 */
export function readPackageVersion(): string {
	try {
		const pkg = require('../package.json') as { version?: string }
		return typeof pkg.version === 'string' && pkg.version.trim()
			? pkg.version.trim()
			: '0.0.0'
	} catch {
		return '0.0.0'
	}
}
