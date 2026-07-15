import type { AnyToolContract } from '@sweatpants/core'
import type { DurableSchemaRegistry, DurableTool } from '@sweatpants/session-contract'
import { createContext, type Operation } from 'effection'
import { toToolParameterJsonSchema } from './tool-parameters.ts'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface ToolCapabilities {
  inline?: boolean
  client?: boolean
  /** Runtime-neutral contract signal derived from the tool definition. */
  elicits?: boolean
  /** Runtime-neutral contract signal derived from the tool definition. */
  samples?: boolean
}

export interface ToolInventoryEntry {
  definition: ToolDefinition
  capabilities?: ToolCapabilities
  metadata?: Record<string, unknown>
}

export interface ToolInventory {
  list(): Operation<ToolInventoryEntry[]>
  resolve(name: string): Operation<ToolInventoryEntry | null>
}

/** Deployment-scoped exact placement readiness used before model exposure. */
export interface ToolPlacementReadiness {
  /** Ordinary public names with an installed executable runtime. */
  ordinaryTools: ReadonlySet<string>
  /** Installed compatible ProgramDriver kinds. */
  drivers: ReadonlySet<string>
  /** Exact pinned program bundle keys (`id@version#digest`). */
  programs: ReadonlySet<string>
  /** Registered exact effect keys (`name@version`). */
  effects: ReadonlySet<string>
  /** Retained current + historical schema validator registry. */
  schemas: DurableSchemaRegistry
  /** Public durable name → selected driver kind. */
  durableDrivers: ReadonlyMap<string, string>
}

/**
 * Intersects generated contracts with complete deployment placement. Durable
 * contracts disappear unless the exact program, compatible driver, every
 * effect, and every reachable schema validator are installed. No ordinary
 * fallback is considered under the same public name.
 */
export function projectAvailableToolContracts(
  contracts: readonly AnyToolContract[],
  readiness: ToolPlacementReadiness,
): AnyToolContract[] {
  return contracts.filter((contract) => {
    if (contract.execution !== 'crank_native') {
      return readiness.ordinaryTools.has(contract.name)
    }
    const durable = contract as AnyToolContract & DurableTool<any, any>
    const manifest = durable.manifest
    if (!manifest) return false
    const driver = readiness.durableDrivers.get(contract.name)
    if (!driver || !readiness.drivers.has(driver)) return false
    if (!readiness.programs.has(`${manifest.programId}@${manifest.version}#${manifest.digest}`)) {
      return false
    }
    for (const effect of Object.values(manifest.effects)) {
      if (!readiness.effects.has(`${effect.name}@${effect.version}`)) return false
    }
    const requiredDigests = [
      manifest.inputSchema.digest,
      manifest.outputSchema.digest,
      ...Object.values(manifest.elicits).flatMap((elicit) => [
        elicit.response.digest,
        ...(elicit.context ? [elicit.context.digest] : []),
      ]),
      ...Object.values(manifest.effects).flatMap((effect) => [
        effect.inputSchema.digest,
        effect.outputSchema.digest,
        ...(effect.cancellation ? [effect.cancellation.partialSchema.digest] : []),
      ]),
    ]
    return readiness.schemas.missing(requiredDigests).length === 0
  })
}

/**
 * Project any execution-neutral tool contract into a model-safe inventory
 * entry. The contract's retained portable parameter projection is consumed
 * directly; the runtime schema is never re-lowered here, and no callable
 * execution surface is required.
 */
export function createToolInventoryEntry(
  tool: AnyToolContract,
  metadata?: Record<string, unknown>,
): ToolInventoryEntry {
  const projection = tool.artifacts?.parameters?.inputProjection
  let parameters: Record<string, unknown>
  if (
    projection !== undefined &&
    projection !== null &&
    typeof projection === 'object' &&
    !Array.isArray(projection)
  ) {
    // Model-facing definitions omit descriptor-internal identifiers.
    const { $id: _id, $schema: _schema, ...rest } = projection as Record<string, unknown>
    parameters = rest
  } else {
    // Legacy runtime tools without artifacts fall back to one-time lowering.
    parameters = toToolParameterJsonSchema(tool.parameters)
  }
  return {
    definition: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
    capabilities: {
      elicits: Boolean(tool.capabilities?.elicitation),
      samples: Boolean(tool.capabilities?.sampling),
    },
    ...(metadata ? { metadata } : {}),
  }
}

export type ToolExposurePhase = 'outer-chat' | 'sample'

export interface SamplingToolDefinitionLike {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  parameters?: Record<string, unknown>
}

export interface ToolExposureRequest {
  phase: ToolExposurePhase
  entries?: ToolInventoryEntry[]
  request?: unknown
  persona?: unknown
  enabledTools?: true | string[]
  enabledPlugins?: string[]
  sampleTools?: SamplingToolDefinitionLike[]
  metadata?: Record<string, unknown>
}

export interface ToolExposurePolicy {
  filter(request: ToolExposureRequest): Operation<ToolDefinition[]>
}

export class ToolInventoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ToolInventoryError'
  }
}

export class ToolExposureError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ToolExposureError'
  }
}

export const ToolInventoryContext = createContext<ToolInventory>('ToolInventory')
export const ToolExposurePolicyContext = createContext<ToolExposurePolicy>('ToolExposurePolicy')

export function createToolInventory(entries: ToolInventoryEntry[]): ToolInventory {
  const ordered = [...entries]
  const byName = new Map<string, ToolInventoryEntry>()

  for (const entry of ordered) {
    const name = entry.definition.name
    if (!name || typeof name !== 'string') {
      throw new ToolInventoryError('TOOL_NAME_INVALID', 'Tool inventory entry requires a canonical definition.name')
    }
    if (byName.has(name)) {
      throw new ToolInventoryError('TOOL_NAME_DUPLICATE', `Duplicate tool name in inventory: ${name}`)
    }
    byName.set(name, entry)
  }

  return {
    *list(): Operation<ToolInventoryEntry[]> {
      return ordered
    },
    *resolve(name: string): Operation<ToolInventoryEntry | null> {
      return byName.get(name) ?? null
    },
  }
}

function stripDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.metadata ? { metadata: definition.metadata } : {}),
  }
}

function sampleDefinition(tool: SamplingToolDefinitionLike): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? tool.inputSchema ?? { type: 'object', properties: {}, required: [] },
  }
}

export const defaultToolExposurePolicy: ToolExposurePolicy = {
  *filter(request: ToolExposureRequest): Operation<ToolDefinition[]> {
    if (request.phase === 'sample') {
      return (request.sampleTools ?? []).map(sampleDefinition)
    }

    const entries = request.entries ?? []
    let selected = entries

    if (request.enabledTools !== true && Array.isArray(request.enabledTools)) {
      const enabled = new Set(request.enabledTools)
      selected = selected.filter((entry) => enabled.has(entry.definition.name))
    }

    if (request.enabledPlugins && request.enabledPlugins.length > 0) {
      const enabled = new Set(request.enabledPlugins)
      const existing = new Set(selected.map((entry) => entry.definition.name))
      selected = [
        ...selected,
        ...entries.filter((entry) => enabled.has(entry.definition.name) && !existing.has(entry.definition.name)),
      ]
    }

    return selected.map((entry) => stripDefinition(entry.definition))
  },
}

export const ToolInventoryApi = {
  *list(): Operation<ToolInventoryEntry[]> {
    const inventory = yield* ToolInventoryContext.get()
    if (!inventory) throw new ToolInventoryError('TOOL_INVENTORY_NOT_CONFIGURED', 'Tool inventory not configured. Install a ToolInventory in scope.')
    return yield* inventory.list()
  },

  *resolve(name: string): Operation<ToolInventoryEntry> {
    const inventory = yield* ToolInventoryContext.get()
    if (!inventory) throw new ToolInventoryError('TOOL_INVENTORY_NOT_CONFIGURED', 'Tool inventory not configured. Install a ToolInventory in scope.')
    const entry = yield* inventory.resolve(name)
    if (!entry) throw new ToolInventoryError('TOOL_NOT_FOUND', `Tool not found: ${name}`)
    return entry
  },
}

export const ToolExposureApi = {
  *definitions(request: ToolExposureRequest): Operation<ToolDefinition[]> {
    const policy = (yield* ToolExposurePolicyContext.get()) ?? defaultToolExposurePolicy
    return yield* policy.filter(request)
  },
}
