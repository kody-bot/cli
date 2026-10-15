import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as esbuild from 'esbuild'
import { createPackageAppEntrySource } from '../src/package-local-runtime-source.js'

test('the kody dev app entry parses and explains a request without the run secret', async () => {
	const source = createPackageAppEntrySource({ sideEffectModules: [] })
	await esbuild.transform(source, { loader: 'js', format: 'esm' })
	assert.match(source, /Forbidden: missing dev run secret\. Open the URL kody dev printed/)
})
