/** Env var for the default org slug (overridden by `--org`). */
export const orgEnvVar = 'KODY_ORG'

/** Public org slug: trim and lowercase, matching the server's `?org=` rules. */
export function orgSlugFromFlag(value: string): string {
	const slug = value.trim().toLowerCase()
	if (!slug) {
		throw new Error(
			'`--org` requires an organization slug. Example: `kody login --org acme`.',
		)
	}
	return slug
}
