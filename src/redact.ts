const secretPattern =
	/(access_token|refresh_token|client_secret|authorization)["']?\s*[:=]\s*["']?[^\s"',}]+/gi

/** Never leak minted API tokens or one-shot bootstrap codes in CLI output. */
const kodySecretPattern = /\bkody_(?:at|bc)_[A-Za-z0-9_-]+\b/g

export function redact(value: string): string {
	return value
		.replace(secretPattern, '$1=[redacted]')
		.replace(kodySecretPattern, 'kody_[redacted]')
}

export function redactError(error: unknown): Error {
	if (error instanceof Error) {
		error.message = redact(error.message)
		return error
	}
	return new Error(redact(String(error)))
}
