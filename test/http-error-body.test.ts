import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redeemBootstrapCode } from '../src/auth-bootstrap.js'
import { nonJsonErrorBodyMaxChars, summarizeNonJsonErrorBody } from '../src/http-error-body.js'

const goodCode = `kody_bc_${'a'.repeat(16)}_${'B'.repeat(32)}`

function largeNotFoundPage(): string {
	const filler = '<div class="row">padding text for a large page</div>\n'.repeat(2000)
	return `<!DOCTYPE html>\n<html><head><title>Not found | Kody</title><style>body{color:red}</style></head><body><h1>Not found</h1>${filler}<script>window.x = 1</script></body></html>`
}

test('summarizeNonJsonErrorBody keeps a short plain-text body as-is', () => {
	assert.equal(summarizeNonJsonErrorBody('  upstream unavailable \n'), 'upstream unavailable')
})

test('summarizeNonJsonErrorBody reduces an HTML page to its title and size', () => {
	const page = largeNotFoundPage()
	const summary = summarizeNonJsonErrorBody(page)
	assert.match(summary, /^Not found \| Kody \(HTML response, \d+ bytes; check --api-url/)
	assert.ok(summary.includes(String(Buffer.byteLength(page))))
	assert.ok(summary.length < 200)
	assert.doesNotMatch(summary, /<|padding text|window\.x/)
})

test('summarizeNonJsonErrorBody falls back to stripped page text without a title', () => {
	const summary = summarizeNonJsonErrorBody(
		'<html><body><script>secret()</script><p>Bad &amp; gateway</p></body></html>',
	)
	assert.match(summary, /^Bad & gateway \(HTML response/)
	assert.doesNotMatch(summary, /secret\(\)/)
})

test('summarizeNonJsonErrorBody truncates a long non-JSON body', () => {
	const summary = summarizeNonJsonErrorBody('x'.repeat(5000))
	assert.ok(summary.startsWith(`${'x'.repeat(nonJsonErrorBodyMaxChars)}…`))
	assert.match(summary, /\(non-JSON response, 5000 bytes; /)
})

test('redeemBootstrapCode does not dump an HTML 404 page from the wrong host', async () => {
	const page = largeNotFoundPage()
	assert.ok(page.length > 90_000)
	const fetchFn = (async () =>
		new Response(page, {
			status: 404,
			headers: { 'content-type': 'text/html; charset=utf-8' },
		})) as typeof fetch
	const error = await redeemBootstrapCode({
		code: goodCode,
		lifetime: 'short',
		apiUrl: 'https://kody-pr-1.kody-a99.workers.dev',
		fetchFn,
	}).then(
		() => null,
		(caught: unknown) => caught,
	)
	assert.ok(error instanceof Error)
	assert.match(error.message, /^Bootstrap redeem failed \(HTTP 404\)\./)
	assert.match(error.message, /Server said: Not found \| Kody \(HTML response, \d+ bytes; check --api-url/)
	assert.ok(error.message.length < 500, `message was ${error.message.length} chars`)
})
