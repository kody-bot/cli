import { createInterface } from 'node:readline'
import { defaultMcpUrl } from './defaults.js'
import { orgSlugFromFlag } from './oauth-provider.js'
import {
	listStoredOrgs,
	loadCredentialStore,
	promotePendingOrg,
	setActiveOrg,
	type ListedOrg,
	type MultiOrgCredentialStore,
	type SecretBackend,
	type StoreResolution,
} from './store.js'

export const orgEnvVar = 'KODY_ORG'

/**
 * Precedence for which org a command acts as: `--org` flag, then `KODY_ORG`,
 * then the active org in the credential store.
 */
export function resolveOrgSlug(input: {
	flag?: string
	env?: NodeJS.ProcessEnv
}): string | undefined {
	if (input.flag !== undefined) return orgSlugFromFlag(input.flag)
	const fromEnv = input.env?.[orgEnvVar] ?? process.env[orgEnvVar]
	if (typeof fromEnv === 'string' && fromEnv.trim()) {
		return orgSlugFromFlag(fromEnv)
	}
	return undefined
}

/** Offline help / listing block. No network. */
export function formatStoredOrgsHelpBlock(
	orgs: Array<ListedOrg>,
	options: { indent?: string } = {},
): string {
	const indent = options.indent ?? '  '
	if (orgs.length === 0) {
		return `${indent}Not logged in. Run \`kody login\`.\n`
	}
	const lines = [`${indent}Logged-in orgs:`]
	for (const org of orgs) {
		const mark = org.active ? '*' : ' '
		const pending = org.pending ? '  (slug pending — run any authenticated command)' : ''
		lines.push(`${indent}  ${mark} ${org.slug}${org.active ? '  (active)' : ''}${pending}`)
	}
	return `${lines.join('\n')}\n`
}

export function readStoredOrgsForHelp(
	mcpUrl: string = defaultMcpUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): Array<ListedOrg> {
	try {
		return listStoredOrgs(mcpUrl, backend, resolution)
	} catch {
		return []
	}
}

export function formatOrgListHuman(orgs: Array<ListedOrg>): string {
	if (orgs.length === 0) {
		return 'Not logged in. Run `kody login`.\n'
	}
	const lines: Array<string> = []
	for (const org of orgs) {
		const mark = org.active ? '*' : ' '
		const pending = org.pending ? '  (slug pending)' : ''
		lines.push(`${mark} ${org.slug}${org.active ? '  (active)' : ''}${pending}`)
	}
	return `${lines.join('\n')}\n`
}

export function formatOrgListJson(orgs: Array<ListedOrg>): string {
	return `${JSON.stringify(
		{
			orgs: orgs.map((org) => ({
				slug: org.pending ? null : org.slug,
				active: org.active,
				...(org.pending ? { pending: true } : {}),
			})),
		},
		null,
		2,
	)}\n`
}

/**
 * Interactive org picker for humans. Requires a TTY. Agents should pass a slug
 * to `kody org use <slug>` instead.
 */
export async function chooseOrgInteractively(input: {
	orgs: Array<ListedOrg>
	stdin?: NodeJS.ReadableStream
	stdout?: NodeJS.WritableStream
	isTTY?: boolean
}): Promise<string> {
	const isTTY = input.isTTY ?? Boolean(process.stdin.isTTY)
	if (!isTTY) {
		throw new Error(
			'`kody org use` without a slug requires a TTY. Pass an org slug: `kody org use <slug>`.',
		)
	}
	const usable = input.orgs.filter((org) => !org.pending)
	if (usable.length === 0) {
		throw new Error(
			'No named org logins yet. Run `kody login`, or an authenticated command to finish migrating a legacy session.',
		)
	}
	const stdout = input.stdout ?? process.stdout
	stdout.write('Select an organization:\n')
	usable.forEach((org, index) => {
		const active = org.active ? ' (active)' : ''
		stdout.write(`  ${index + 1}) ${org.slug}${active}\n`)
	})
	const rl = createInterface({
		input: input.stdin ?? process.stdin,
		output: stdout,
		terminal: true,
	})
	try {
		const answer = await new Promise<string>((resolve) => {
			rl.question('Number (or slug): ', (line) => resolve(line.trim()))
		})
		if (!answer) {
			throw new Error('No organization selected.')
		}
		const asNumber = Number(answer)
		if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= usable.length) {
			return usable[asNumber - 1]!.slug
		}
		return orgSlugFromFlag(answer)
	} finally {
		rl.close()
	}
}

export function useOrg(
	slug: string,
	mcpUrl: string = defaultMcpUrl,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): MultiOrgCredentialStore {
	return setActiveOrg(mcpUrl, orgSlugFromFlag(slug), backend, resolution)
}

export function promoteLegacyIfNeeded(
	mcpUrl: string,
	orgSlug: string,
	backend?: SecretBackend,
	resolution?: StoreResolution,
): MultiOrgCredentialStore | null {
	const snapshot = loadCredentialStore(mcpUrl, backend, resolution)
	if (!snapshot?.pending) return snapshot
	return promotePendingOrg(mcpUrl, orgSlug, backend, resolution)
}
