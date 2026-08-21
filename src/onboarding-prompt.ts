import { onboardingUrl } from './defaults.js'

export function buildOnboardingContinuationPrompt(): string {
	return [
		'Kody is connected as an MCP server in this agent.',
		'Help me get started with Kody.',
		'First, briefly explain what Kody can do for me in plain language.',
		'Then help me connect one integration I care about: check coding_guide_get for a matching provider guide (for example provider_github or provider_google) and follow it; otherwise use search and the official guides to find the right setup steps, walk me through the connect or secrets flow, and verify the connection with a small ad hoc execute smoke test.',
		'Do not create any packages until the integration works — start with ad hoc execute calls.',
		'Once the integration works, check community_search for a trusted community package that is close to what I want, fork or adapt it (community_fork, or point me at one-click install on /onboarding or the listing detail), and only create a new package if nothing suitable exists.',
	].join(' ')
}

export function webClientsOnboardingNote(mcpUrl: string): string {
	return `For web-based clients (ChatGPT, Claude.ai, Grok), see ${onboardingUrl(mcpUrl)}`
}
