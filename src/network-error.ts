/** `fetch failed` alone hides why; undici puts ECONNREFUSED / ENOTFOUND on `cause.code`. */
export function describeNetworkError(error: unknown): string {
	if (!(error instanceof Error)) return String(error)
	const cause = error.cause
	const causeCode =
		cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
			? cause.code
			: null
	return causeCode ? `${error.message}: ${causeCode}` : error.message
}
