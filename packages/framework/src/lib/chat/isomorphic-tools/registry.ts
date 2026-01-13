/**
 * Isomorphic Tool Registry
 *
 * Manages a collection of isomorphic tools and provides:
 * - Tool lookup by name
 * - Schema generation for LLM (tool definitions)
 * - Server-only tool extraction (for server executor)
 * - Client tool lookup (for handoff processing)
 */
import { z } from 'zod'
import type {
  AnyIsomorphicTool,
  IsomorphicToolRegistry,
  IsomorphicToolSchema,
  ServerOnlyToolDef,
} from './types.ts'

/**
 * Create an isomorphic tool registry.
 *
 * @example
 * ```typescript
 * const registry = createIsomorphicToolRegistry([
 *   drawCardTool,
 *   confirmSeenTool,
 *   getUserChoiceTool,
 * ])
 *
 * // Get schemas for LLM
 * const schemas = registry.toToolSchemas()
 *
 * // Get server tools for executor
 * const serverTools = registry.toServerTools()
 *
 * // Lookup tool for handoff processing
 * const tool = registry.get('draw_card')
 * ```
 */
export function createIsomorphicToolRegistry(
  tools: AnyIsomorphicTool[]
): IsomorphicToolRegistry {
  const map = new Map<string, AnyIsomorphicTool>()
  for (const tool of tools) {
    if (map.has(tool.name)) {
      throw new Error(`Duplicate isomorphic tool name: ${tool.name}`)
    }
    map.set(tool.name, tool)
  }

  return {
    tools: map,

    get(name: string): AnyIsomorphicTool | undefined {
      return map.get(name)
    },

    has(name: string): boolean {
      return map.has(name)
    },

    names(): string[] {
      return Array.from(map.keys())
    },

    toServerTools(): ServerOnlyToolDef[] {
      return Array.from(map.values()).map((tool) => {
        if (!tool.server) {
          throw new Error(`Isomorphic tool "${tool.name}" has no server implementation`)
        }

        return {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          authority: tool.authority ?? 'server',
          execute: tool.server,
        }
      })
    },

    toToolSchemas(): IsomorphicToolSchema[] {
      return Array.from(map.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.parameters),
        isIsomorphic: true,
        authority: tool.authority ?? 'server',
      }))
    },
  }
}

/**
 * Merge an isomorphic tool registry with a regular tool registry.
 *
 * Returns tools in OpenAI function format for the LLM.
 * Isomorphic tools are marked with a metadata flag.
 */
export function mergeWithServerTools(
  isomorphicRegistry: IsomorphicToolRegistry,
  serverToolSchemas: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
): Array<{
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: boolean
  _isomorphic?: boolean
  _authority?: string
}> {
  const isomorphicSchemas = isomorphicRegistry.toToolSchemas()

  // Isomorphic tools
  const isomorphicTools = isomorphicSchemas.map((schema) => ({
    type: 'function' as const,
    name: schema.name,
    description: schema.description,
    parameters: {
      ...schema.parameters,
      additionalProperties: false,
    },
    strict: false,
    _isomorphic: true,
    _authority: schema.authority,
  }))

  // Regular server tools
  const serverTools = serverToolSchemas.map((schema) => ({
    type: 'function' as const,
    name: schema.name,
    description: schema.description,
    parameters: {
      ...schema.parameters,
      additionalProperties: false,
    },
    strict: false,
  }))

  return [...isomorphicTools, ...serverTools]
}

/**
 * Filter a registry to only include specific tools.
 */
export function filterIsomorphicRegistry(
  registry: IsomorphicToolRegistry,
  toolNames: string[]
): IsomorphicToolRegistry {
  const filtered: AnyIsomorphicTool[] = []
  for (const name of toolNames) {
    const tool = registry.get(name)
    if (tool) {
      filtered.push(tool)
    }
  }
  return createIsomorphicToolRegistry(filtered)
}

// --- Helper Functions ---

/**
 * Convert a Zod schema to JSON Schema.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Use Zod's built-in JSON schema conversion
  return z.toJSONSchema(schema) as Record<string, unknown>
}
