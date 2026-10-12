export const nonJsonErrorBodyMaxChars = 200

/**
 * A wrong `--api-url` (for example a preview's app origin instead of its
 * `-api` host) answers `/v1/*` with a full HTML page. Reduce a non-JSON error
 * body to a short single-line excerpt so the error stays readable.
 */
export function summarizeNonJsonErrorBody(text: string): string {
	const trimmed = text.trim()
	const looksLikeHtml = /^<(?:!doctype|html|head|body)\b/i.test(trimmed)
	const title = looksLikeHtml ? trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] : undefined
	const excerpt = collapseWhitespace(
		looksLikeHtml ? stripHtml(title?.trim() ? title : trimmed) : trimmed,
	)
	const kind = looksLikeHtml ? 'HTML' : 'non-JSON'
	const bytes = Buffer.byteLength(text)
	if (excerpt.length <= nonJsonErrorBodyMaxChars && !looksLikeHtml) return excerpt
	const shortened =
		excerpt.length > nonJsonErrorBodyMaxChars
			? `${excerpt.slice(0, nonJsonErrorBodyMaxChars).trimEnd()}…`
			: excerpt
	return `${shortened ? `${shortened} ` : ''}(${kind} response, ${bytes} bytes; check --api-url / KODY_API_URL points at the Kody API host)`
}

function stripHtml(html: string): string {
	return html
		.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}
