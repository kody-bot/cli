/**
 * When `.kody/mocks.ts` is active under `--target mock`, embed the CLI-owned
 * gateway-fetch shim and ensure the workerd entry side-effect imports it.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localExecuteGatewayFetchShimModuleName } from '../local-package-graph.js'
import type { WorkerdPackageModuleFile } from '../local-runtime-source.js'
import { createMockGatewayFetchShimSource } from './mock-gateway-fetch-shim.js'

const mockShimFileName = 'mock-gateway-fetch-shim.js'

export async function installMockFetchShimModules(input: {
	workDir: string
	packageModules: Array<WorkerdPackageModuleFile>
}): Promise<{
	packageModules: Array<WorkerdPackageModuleFile>
	sideEffectModules: Array<typeof localExecuteGatewayFetchShimModuleName>
}> {
	const withoutOriginShim = input.packageModules.filter(
		(module) => module.name !== localExecuteGatewayFetchShimModuleName,
	)
	await writeFile(
		join(input.workDir, mockShimFileName),
		createMockGatewayFetchShimSource(),
	)
	return {
		packageModules: [
			...withoutOriginShim,
			{
				name: localExecuteGatewayFetchShimModuleName,
				file: mockShimFileName,
			},
		],
		sideEffectModules: [localExecuteGatewayFetchShimModuleName],
	}
}
