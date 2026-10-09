/**
 * Sources for the workerd process behind `execute --local`. User code sees the
 * same `kody:runtime` surface as ad hoc cloud execute; every call becomes a
 * `{ path, args }` hop to the CLI's loopback bridge, which adds the API token
 * and forwards it to CapabilityProxy. The token never enters workerd.
 *
 * Stamped `kody:@…` packages also receive a package-graph CapabilityProxy shim
 * from origin. This host module still binds createAuthenticatedFetch /
 * secretHeaders / oauthClientCredentials for ad hoc imports, and the entry
 * installs the shared runtime ALS before evaluating user code so published
 * bundles that inline optional runtime exports (Dropbox-style) see a populated
 * store at module evaluation — matching cloud `__kodyRunInRuntime`.
 */

export const localExecuteCompatibilityDate = '2026-04-16'
export const localExecuteCompatibilityFlags = ['nodejs_compat'] as const

export const localWorkerModuleNames = {
	entry: '__kody_local_entry.js',
	user: 'main.js',
	runtime: 'kody:runtime',
} as const

/** Header carrying the per-run secret on workerd → bridge and CLI → workerd hops. */
export const runSecretHeader = 'x-kody-run-secret'
export const runSecretEnvVar = 'KODY_RUN_SECRET'

/** Runtime ALS symbol shared with stamped / inlined `kody:runtime` helpers. */
export const kodyRuntimeStorageSymbolDescription = 'kody.runtimeStorage'

export function createLocalRuntimeModuleSource(): string {
	return `
import { AsyncLocalStorage } from 'node:async_hooks';

let __kodyBridge = null;

export function __kodyInstallLocalBridge(bridge) {
	__kodyBridge = bridge;
}

function __kodyCall(path, args) {
	if (__kodyBridge === null) {
		throw new Error('kody:runtime is only available while an execute --local run is in progress.');
	}
	return __kodyBridge(path, args);
}

function __kodyNamespace(path) {
	const label = '[KodyRuntime:' + path.join('.') + ']';
	return new Proxy(function () {}, {
		get(_target, property) {
			if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') {
				return undefined;
			}
			if (property === 'toString' || property === 'inspect') return () => label;
			return __kodyNamespace([...path, property]);
		},
		apply(_target, _thisArg, args) {
			return __kodyCall(path, args);
		},
	});
}

export const kody = __kodyNamespace(['kody']);

export const workflows = {
	create: async (input) => await __kodyCall(['workflows', 'create'], [input ?? {}]),
};

// Always null: there is no author-facing packages.invoke. Use a static
// kody:@scope/package/export import when the name is known, or import(specifier)
// when the name is data. Under --local, static kody:@ imports are resolved into
// the workerd module list via POST /v1/local-execute/package-graph (see
// local-package-graph.ts / kentcdodds/kody#2808) — never a whole-module
// CapabilityProxy → kody.execute hop.
export const packages = null;

export function packageStorage() {
	throw new Error(
		'packageStorage() requires package provenance: this module was not bundled from a saved package and the run has no package context. ' +
			'Ad hoc execute has no scratch SQLite helper. Persist durable state from a saved package with packageStorage().',
	);
}

function __kodyPackageSecretsUnavailable() {
	throw new Error(
		'packageSecrets is not available in this execution context. It is bound for stamped saved-package modules and saved-package runtime contexts.',
	);
}

export const packageSecrets = {
	get: async () => __kodyPackageSecretsUnavailable(),
	has: async () => __kodyPackageSecretsUnavailable(),
};
export const packageContext = Object.freeze({});
export const email = null;
export const events = null;

const __kodyNullBodyStatuses = new Set([204, 205, 304]);

function __kodyBytesToBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function __kodyBase64ToBytes(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function __kodyBodyToBytes(body) {
	if (typeof body === 'string') {
		return new TextEncoder().encode(body);
	}
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
			'Local execute createAuthenticatedFetch does not support FormData bodies yet; use Uint8Array, Blob, or string.',
		);
	}
	throw new Error(
		'Local execute createAuthenticatedFetch could not serialize the request body.',
	);
}

export async function createAuthenticatedFetch(providerName) {
	const name = String(providerName ?? '').trim();
	if (!name) {
		throw new Error('Integration name is required.');
	}
	return async (input, init) => {
		let url;
		let method = 'GET';
		let headers = {};
		let bodyBytes = null;
		if (typeof input === 'string' || input instanceof URL) {
			url = String(input);
			method = String(init?.method ?? 'GET');
			headers = Object.fromEntries(new Headers(init?.headers).entries());
			if (init?.body != null) {
				bodyBytes = await __kodyBodyToBytes(init.body);
			}
		} else {
			const merged = new Request(input, init);
			url = merged.url;
			method = merged.method;
			headers = Object.fromEntries(merged.headers.entries());
			if (method !== 'GET' && method !== 'HEAD') {
				bodyBytes = new Uint8Array(await merged.arrayBuffer());
			}
		}
		const result = await __kodyCall(['kody', 'authenticatedFetch'], [{
			providerName: name,
			request: {
				url,
				method,
				headers,
				...(bodyBytes != null
					? { bodyBase64: __kodyBytesToBase64(bodyBytes) }
					: {}),
			},
		}]);
		const bytes = __kodyBase64ToBytes(result.bodyBase64 ?? '');
		return new Response(
			__kodyNullBodyStatuses.has(result.status) ? null : bytes,
			{
				status: result.status,
				statusText: result.statusText,
				headers: result.headers,
			},
		);
	};
}

export const secretHeaders = {
	basic(input) {
		const usernameSecret = String(input?.usernameSecret ?? '').trim();
		const passwordSecret = String(input?.passwordSecret ?? '').trim();
		if (!usernameSecret || !passwordSecret) {
			throw new Error(
				'secretHeaders.basic requires usernameSecret and passwordSecret.',
			);
		}
		const scope =
			typeof input?.scope === 'string' && input.scope.trim()
				? input.scope.trim()
				: null;
		return scope
			? \`{{secret-basic:username=\${usernameSecret},password=\${passwordSecret}|scope=\${scope}}}\`
			: \`{{secret-basic:username=\${usernameSecret},password=\${passwordSecret}}}\`;
	},
};

export async function oauthClientCredentials(input) {
	return await __kodyCall(['kody', 'oauthClientCredentials'], [input ?? {}]);
}

const __kodyRuntimeStorageSymbol = Symbol.for(${JSON.stringify(kodyRuntimeStorageSymbolDescription)});
const __globalAny = globalThis;
const __kodyRuntimeStorage =
	__globalAny[__kodyRuntimeStorageSymbol] ??
	(__globalAny[__kodyRuntimeStorageSymbol] = new AsyncLocalStorage());

const __kodyRuntimeDefault = Object.freeze({
	kody,
	packageStorage,
	createAuthenticatedFetch,
	secretHeaders,
	oauthClientCredentials,
	packageContext,
	packageSecrets,
	email,
	workflows,
	packages,
	events,
});
export default __kodyRuntimeDefault;
export const KodyRuntime = Object.freeze({ defaultValue: __kodyRuntimeDefault });

/** Enter the shared runtime ALS before evaluating user / package modules. */
export function __kodyRunInLocalRuntime(callback) {
	return __kodyRuntimeStorage.run(__kodyRuntimeDefault, callback);
}
`.trimStart()
}

/**
 * Local workerd entry. Optional `sideEffectModules` are imported for their
 * evaluation side effects before the user module runs — used to load the
 * origin-supplied gateway-fetch shim so ambient `{{secret:…}}` fetch hops
 * even when the entry has no `kody:@` imports (kentcdodds/kody#3020).
 */
export function createLocalEntrySource(input: {
	sideEffectModules?: ReadonlyArray<string>
} = {}): string {
	const sideEffectImports = [...new Set(input.sideEffectModules ?? [])]
		.filter((name) => typeof name === 'string' && name.trim().length > 0)
		.map((name) => `import ${JSON.stringify(name)};`)
		.join('\n')
	const sideEffectBlock = sideEffectImports ? `${sideEffectImports}\n` : ''
	return `
${sideEffectBlock}import {
	__kodyInstallLocalBridge,
	__kodyRunInLocalRuntime,
} from ${JSON.stringify(localWorkerModuleNames.runtime)};

const __kodyRunSecretHeader = ${JSON.stringify(runSecretHeader)};
let __kodyClaimed = false;

function __kodyFormatLogArgs(args) {
	return args.map(String).join(' ');
}

export default {
	async fetch(request, env) {
		const secret = env.${runSecretEnvVar};
		if (__kodyClaimed || !secret || request.headers.get(__kodyRunSecretHeader) !== secret) {
			return new Response('Forbidden', { status: 403 });
		}
		__kodyClaimed = true;
		const { params } = await request.json();
		__kodyInstallLocalBridge(async (path, args) => {
			const response = await env.KODY_BRIDGE.fetch('http://kody-bridge/call', {
				method: 'POST',
				headers: { 'content-type': 'application/json', [__kodyRunSecretHeader]: secret },
				body: JSON.stringify({ path, args }),
			});
			const data = await response.json();
			if (data.error) throw new Error(data.error);
			return data.result;
		});
		const logs = [];
		const nativeConsole = globalThis.console;
		globalThis.console = {
			...nativeConsole,
			log: (...a) => { logs.push(__kodyFormatLogArgs(a)); },
			info: (...a) => { logs.push('[info] ' + __kodyFormatLogArgs(a)); },
			debug: (...a) => { logs.push('[debug] ' + __kodyFormatLogArgs(a)); },
			warn: (...a) => { logs.push('[warn] ' + __kodyFormatLogArgs(a)); },
			error: (...a) => { logs.push('[error] ' + __kodyFormatLogArgs(a)); },
		};
		try {
			// Evaluate user + stamped package modules inside the runtime ALS so
			// inlined optional exports capture callable helpers (cloud parity).
			const result = await __kodyRunInLocalRuntime(async () => {
				const module = await import(${JSON.stringify(`./${localWorkerModuleNames.user}`)});
				if (typeof module?.default !== 'function') {
					throw new Error('Kody execute modules must default export a function.');
				}
				return await module.default(params);
			});
			return new Response(JSON.stringify({ result, logs }), {
				headers: { 'content-type': 'application/json' },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ error: message, logs });
		} finally {
			globalThis.console = nativeConsole;
		}
	},
};
`.trimStart()
}

export type WorkerdPackageModuleFile = {
	/** Exact module name as imported from user / package code (e.g. `kody:@scope/pkg/export`). */
	name: string
	/** Path relative to the workerd config file. */
	file: string
}

/**
 * workerd text config. `files` are embedded relative to the config file.
 * Outbound fetch is public-only unless private-network access is explicitly
 * enabled. The loopback bridge remains a separate external service.
 *
 * Optional `packageModules` are stamped `kody:@…` (and nested) modules from
 * POST /v1/local-execute/package-graph — embedded alongside the user module so
 * imports resolve inside local workerd without a remote `kody.execute`.
 */
export function createWorkerdConfig(input: {
	bridgePort: number
	files: { entry: string; user: string; runtime: string }
	packageModules?: Array<WorkerdPackageModuleFile>
	allowPrivateNetwork?: boolean
}): string {
	const flags = localExecuteCompatibilityFlags.map((flag) => JSON.stringify(flag)).join(', ')
	const networkAllow = input.allowPrivateNetwork
		? '["public", "private", "local"]'
		: '["public"]'
	const packageEntries = (input.packageModules ?? [])
		.map(
			(module) =>
				`    (name = ${JSON.stringify(module.name)}, esModule = embed ${JSON.stringify(module.file)}),`,
		)
		.join('\n')
	const packageBlock = packageEntries ? `\n${packageEntries}` : ''
	return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .kodyWorker),
    (name = "kody-bridge", external = (address = "127.0.0.1:${input.bridgePort}", http = ())),
    (name = "internet", network = (allow = ${networkAllow}, tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:0", http = (), service = "main") ],
);

const kodyWorker :Workerd.Worker = (
  modules = [
    (name = ${JSON.stringify(localWorkerModuleNames.entry)}, esModule = embed ${JSON.stringify(input.files.entry)}),
    (name = ${JSON.stringify(localWorkerModuleNames.user)}, esModule = embed ${JSON.stringify(input.files.user)}),
    (name = ${JSON.stringify(localWorkerModuleNames.runtime)}, esModule = embed ${JSON.stringify(input.files.runtime)}),${packageBlock}
  ],
  compatibilityDate = ${JSON.stringify(localExecuteCompatibilityDate)},
  compatibilityFlags = [${flags}],
  globalOutbound = "internet",
  bindings = [
    (name = "KODY_BRIDGE", service = "kody-bridge"),
    (name = ${JSON.stringify(runSecretEnvVar)}, fromEnvironment = ${JSON.stringify(runSecretEnvVar)}),
  ],
);
`
}
