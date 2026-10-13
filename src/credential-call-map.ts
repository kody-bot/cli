/**
 * CLI `--credential` picks for ADR 0068 call maps.
 *
 * Flag shapes (repeatable):
 * - `--credential github=work`
 * - `--credential x=org:work` / `--credential x=personal:work`
 * - `--credential github=` → none on purpose (`[]`)
 *
 * Repeated keys become an array for `credentials(key)`. The map is sent as the
 * CapabilityProxy call's top-level `credentials` field (never inside `args`),
 * or as MCP `execute` `credentials`.
 */

export const credentialCallMapFeature = 'credential-call-map'

export const credentialCallMapLimits = {
	maxKeys: 32,
	maxPicksPerKey: 16,
	maxTextLength: 100,
} as const

const keyPattern = new RegExp(
	`^[A-Za-z0-9][A-Za-z0-9._-]{0,${credentialCallMapLimits.maxTextLength - 1}}$`,
)

export type CredentialPickInput =
	| string
	| { name: string; scope?: 'org' | 'personal' }

/** JSON shape accepted by CapabilityProxy / MCP execute `credentials`. */
export type CredentialCallMapInput = Record<
	string,
	CredentialPickInput | Array<CredentialPickInput>
>

export function parseCredentialFlag(raw: string): {
	key: string
	picks: Array<CredentialPickInput>
} {
	const eq = raw.indexOf('=')
	if (eq <= 0) {
		throw new Error(
			`Invalid --credential ${JSON.stringify(raw)}. Use --credential key=name, --credential key=org:name, or --credential key= for none.`,
		)
	}
	const key = raw.slice(0, eq)
	const value = raw.slice(eq + 1)
	assertCredentialMapKey(key)
	if (value === '') return { key, picks: [] }
	return { key, picks: [parseCredentialPick(value)] }
}

export function parseCredentialFlags(
	flags: ReadonlyArray<string> | undefined,
): CredentialCallMapInput | undefined {
	if (!flags || flags.length === 0) return undefined
	const collected = new Map<string, Array<CredentialPickInput>>()
	for (const flag of flags) {
		const { key, picks } = parseCredentialFlag(flag)
		const existing = collected.get(key) ?? []
		existing.push(...picks)
		if (existing.length > credentialCallMapLimits.maxPicksPerKey) {
			throw new Error(
				`A credentials map takes at most ${credentialCallMapLimits.maxPicksPerKey} picks per key (${key}).`,
			)
		}
		collected.set(key, existing)
	}
	if (collected.size > credentialCallMapLimits.maxKeys) {
		throw new Error(
			`A credentials map takes at most ${credentialCallMapLimits.maxKeys} keys.`,
		)
	}
	const map: CredentialCallMapInput = {}
	for (const [key, picks] of collected) {
		map[key] = picks.length === 1 ? picks[0]! : picks
	}
	return map
}

function parseCredentialPick(value: string): CredentialPickInput {
	const scoped = /^(org|personal):(.+)$/.exec(value)
	if (scoped) {
		const name = scoped[2]!
		assertCredentialText(name, 'credential name')
		return { name, scope: scoped[1] as 'org' | 'personal' }
	}
	assertCredentialText(value, 'credential name')
	return value
}

function assertCredentialMapKey(key: string): void {
	if (!keyPattern.test(key)) {
		throw new Error(
			`Invalid --credential key ${JSON.stringify(key)}. A key starts with a letter or digit and uses letters, digits, dots, underscores, or hyphens (max ${credentialCallMapLimits.maxTextLength}).`,
		)
	}
}

function assertCredentialText(value: string, label: string): void {
	const trimmed = value.trim()
	if (!trimmed || trimmed.length > credentialCallMapLimits.maxTextLength) {
		throw new Error(
			`Invalid --credential ${label} ${JSON.stringify(value)}. Use 1–${credentialCallMapLimits.maxTextLength} characters.`,
		)
	}
	if (trimmed !== value) {
		throw new Error(
			`Invalid --credential ${label} ${JSON.stringify(value)}. Leading or trailing spaces are not allowed.`,
		)
	}
}

export function sessionSupportsCredentialCallMap(
	features: ReadonlyArray<string> | undefined,
): boolean {
	return Array.isArray(features) && features.includes(credentialCallMapFeature)
}

export function missingCredentialCallMapFeatureMessage(apiUrl: string): string {
	return `This Kody API (${apiUrl}) does not advertise CapabilityProxy feature \`${credentialCallMapFeature}\`, which --credential needs. Upgrade the API (ADR 0068 call maps / #3599) or omit --credential.`
}
