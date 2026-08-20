const secretPattern =
	/(access_token|refresh_token|client_secret|authorization)["']?\s*[:=]\s*["']?[^\s"',}]+/gi

export function redact(value: string): string {
	return value.replace(secretPattern, '$1=[redacted]')
}

export function redactError(error: unknown): Error {
	if (error instanceof Error) {
		error.message = redact(error.message)
		return error
	}
	return new Error(redact(String(error)))
}
