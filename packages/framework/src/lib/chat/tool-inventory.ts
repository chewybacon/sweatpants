import { createContext, type Operation } from 'effection'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface ToolCapabilities {
  inline?: boolean
  client?: boolean
  worker?: boolean
  session?: boolean
  remote?: boolean
  elicits?: boolean
  samples?: boolean
}

export interface ToolInventoryEntry<TImplementation = unknown> {
  definition: ToolDefinition
  implementation?: TImplementation
  capabilities?: ToolCapabilities
  metadata?: Record<string, unknown>
}

export interface ToolInventory {
  list(): Operation<ToolInventoryEntry[]>
  resolve(name: string): Operation<ToolInventoryEntry | null>
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
