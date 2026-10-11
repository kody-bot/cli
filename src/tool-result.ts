export type ToolCallResult = {
	content: Array<{ type: string; text?: string; [key: string]: unknown }>
	structuredContent?: unknown
	isError?: boolean
}

export function formatToolResult(
	result: ToolCallResult,
	json: boolean,
): string {
	if (json) {
		return `${JSON.stringify(
			{
				isError: result.isError ?? false,
				structuredContent: result.structuredContent ?? null,
				content: result.content,
			},
			null,
			2,
		)}\n`
	}
	const texts = result.content
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text ?? '')
	if (texts.length > 0) return texts.join('\n\n').replace(/\n*$/, '\n')
	if (result.structuredContent != null) {
		return `${JSON.stringify(result.structuredContent, null, 2)}\n`
	}
	return `${JSON.stringify(result.content, null, 2)}\n`
}
