/**
 * Sources for the workerd process behind `execute --local`. User code sees the
 * same `kody:runtime` surface as ad hoc cloud execute; every call becomes a
 * `{ path, args }` hop to the CLI's loopback bridge, which adds the API token
 * and forwards it to CapabilityProxy. The token never enters workerd.
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

export function createLocalRuntimeModuleSource(): string {
	return `
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
// when the name is data. Under --local, those imports fall back to
// CapabilityProxy → kody.execute so the origin can resolve the package graph.
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
export const createAuthenticatedFetch = undefined;
export const secretHeaders = undefined;
export const oauthClientCredentials = undefined;

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
`.trimStart()
}

export function createLocalEntrySource(): string {
	return `
import { __kodyInstallLocalBridge } from ${JSON.stringify(localWorkerModuleNames.runtime)};

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
			const module = await import(${JSON.stringify(`./${localWorkerModuleNames.user}`)});
			if (typeof module?.default !== 'function') {
				throw new Error('Kody execute modules must default export a function.');
			}
			const result = await module.default(params);
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

/**
 * workerd text config. `files` are embedded relative to the config file.
 * Outbound fetch reaches public and private networks: local execute runs as
 * the user on their own machine, and reaching local services is part of why
 * one would run locally.
 */
export function createWorkerdConfig(input: {
	bridgePort: number
	files: { entry: string; user: string; runtime: string }
}): string {
	const flags = localExecuteCompatibilityFlags.map((flag) => JSON.stringify(flag)).join(', ')
	return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .kodyWorker),
    (name = "kody-bridge", external = (address = "127.0.0.1:${input.bridgePort}", http = ())),
    (name = "internet", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:0", http = (), service = "main") ],
);

const kodyWorker :Workerd.Worker = (
  modules = [
    (name = ${JSON.stringify(localWorkerModuleNames.entry)}, esModule = embed ${JSON.stringify(input.files.entry)}),
    (name = ${JSON.stringify(localWorkerModuleNames.user)}, esModule = embed ${JSON.stringify(input.files.user)}),
    (name = ${JSON.stringify(localWorkerModuleNames.runtime)}, esModule = embed ${JSON.stringify(input.files.runtime)}),
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
