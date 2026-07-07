import { SessionContractError, type CapabilityListingEntry, type CapabilityMap } from './types.ts'

export function listCapabilities(map: CapabilityMap): CapabilityListingEntry[] {
  return Object.entries(map).map(([name, declaration]) => ({
    name,
    ...(declaration.input !== undefined ? { input: declaration.input } : {}),
    ...(declaration.output !== undefined ? { output: declaration.output } : {}),
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
  }))
}

export function assertDeclaredCapability(map: CapabilityMap, target: string): void {
  if (!(target in map)) {
    throw new SessionContractError('unknown_target', `Unknown capability ${target}`)
  }
}
