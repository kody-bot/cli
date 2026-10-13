/**
 * Mock-only workerd side-effect module (flat name
 * `.__kody_mock_gateway_fetch__.js` — see install-mock-fetch-shim.ts).
 * Wraps ambient `fetch` so every outbound request hops through the Node bridge
 * as `kody.gatewayFetch` (MSW matching / passthrough / unmocked_request).
 * Origin's `.__kody_virtual__/runtime.js` stays for CAF / packageStorage.
 */

import { localWorkerModuleNames } from '../local-runtime-source.js'

/**
 * Source for the CLI-owned mock gateway-fetch shim. Side-effect imported before
 * user code; fetch calls happen after `__kodyInstallLocalBridge`.
 *
 * Registered under a flat module name so bare `"kody:runtime"` resolves to the
 * host module (path-like names like `.__kody_virtual__/runtime.js` path-join).
 */
export function createMockGatewayFetchShimSource(): string {
	return `
import { kody } from ${JSON.stringify(localWorkerModuleNames.runtime)};

const __kodyNativeFetch = globalThis.fetch.bind(globalThis);
const __kodyNullBodyStatuses = new Set([101, 103, 204, 205, 304]);

function __kodyBytesToBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function __kodyBase64ToBytes(value) {
	const binary = atob(String(value ?? ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function __kodyBodyToBytes(body) {
	if (body == null) return null;
	if (typeof body === 'string') return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	if (typeof Blob !== 'undefined' && body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
		return new TextEncoder().encode(body.toString());
	}
	if (body && typeof body.getReader === 'function') {
		return new Uint8Array(await new Response(body).arrayBuffer());
	}
	if (typeof FormData !== 'undefined' && body instanceof FormData) {
		throw new Error(
			'Mock fetch gateway does not support FormData bodies yet; use Uint8Array, Blob, or string.',
		);
	}
	throw new Error('Mock fetch gateway could not serialize the request body.');
}

globalThis.fetch = async (input, init) => {
	let url;
	let method = 'GET';
	let headers = {};
	let bodyBytes = null;
	if (typeof input === 'string' || input instanceof URL) {
		url = String(input);
		method = String(init?.method ?? 'GET');
		headers = Object.fromEntries(new Headers(init?.headers).entries());
		if (init?.body != null) bodyBytes = await __kodyBodyToBytes(init.body);
	} else {
		const merged = new Request(input, init);
		url = merged.url;
		method = merged.method;
		headers = Object.fromEntries(merged.headers.entries());
		if (method !== 'GET' && method !== 'HEAD') {
			bodyBytes = new Uint8Array(await merged.arrayBuffer());
		}
	}
	const result = await kody.gatewayFetch({
		request: {
			url,
			method,
			headers,
			...(bodyBytes != null ? { bodyBase64: __kodyBytesToBase64(bodyBytes) } : {}),
		},
	});
	const bytes = __kodyBase64ToBytes(result.bodyBase64 ?? '');
	return new Response(
		__kodyNullBodyStatuses.has(result.status) ? null : bytes,
		{
			status: result.status,
			statusText: result.statusText ?? '',
			headers: result.headers ?? {},
		},
	);
};

// Retain a reference so workerd keeps the binding available for debugging.
void __kodyNativeFetch;
export {};
`.trimStart()
}
