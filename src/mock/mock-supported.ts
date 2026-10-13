/**
 * Operations the CLI mock implements. Generated-adjacent: keep this list in
 * sync with handlers in mock-server.ts. Contract tests assert every id here
 * works on mock; anything else must refuse with not_implemented_in_mock.
 *
 * Source of truth for the *prod* surface remains api.kody.codes/openapi.json
 * plus CapabilityProxy paths. When adding a mock handler, add its id here.
 */

/** Open API operationIds the mock answers. */
export const mockOpenApiOperationIds = [
	'search',
	'metaGetCurrentUser',
	'usageGet',
] as const

/** CapabilityProxy `path` joins (dot form) the mock answers under kody.*. */
export const mockCapabilityPaths = [
	'kody.metaGetCurrentUser',
	'kody.search',
	'kody.execute',
	'kody.usageGet',
	// Local package scratch storage via capability hops used by packageStorage()
	// bridging in the mock runtime (see mock-server call dispatch).
	'kody.__mockPackageStorageGet',
	'kody.__mockPackageStorageSet',
	'kody.__mockPackageStorageDelete',
	'kody.__mockPackageStorageList',
	// Credential client open returns fake metadata only (never prod secrets).
	'kody.credentialClientOpen',
	'kody.credentialClientCheck',
] as const

export type MockOpenApiOperationId = (typeof mockOpenApiOperationIds)[number]
export type MockCapabilityPath = (typeof mockCapabilityPaths)[number]

export function isMockOpenApiOperation(id: string): id is MockOpenApiOperationId {
	return (mockOpenApiOperationIds as ReadonlyArray<string>).includes(id)
}

export function isMockCapabilityPath(pathKey: string): pathKey is MockCapabilityPath {
	return (mockCapabilityPaths as ReadonlyArray<string>).includes(pathKey)
}

/** CapabilityProxy routes always present on every target. */
export const mockCapabilityProxyRoutes = [
	'GET /v1/capability-proxy/session',
	'POST /v1/capability-proxy/call',
	'POST /v1/local-execute/package-graph',
] as const
