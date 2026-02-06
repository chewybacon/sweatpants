/**
 * Isomorphic Tool Registry
 *
 * Manages a collection of isomorphic tools and provides:
 * - Tool lookup by name
 * - Schema generation for LLM (tool definitions)
 * - Server-only tool extraction (for server executor)
 * - Client tool lookup (for handoff processing)
 *
 * Also accepts @sweatpants/core tools, which are automatically
 * adapted to the isomorphic tool interface.
 */
import { z } from 'zod'
import type {
  AnyIsomorphicTool,
  IsomorphicToolRegistry,
  IsomorphicToolSchema,
  ServerOnlyToolDef,
} from './types.ts'
import { adaptCoreTool, isCoreToolFactory, type CoreToolFactory } from '../core-tools/adapter.ts'

/**
 * Input types accepted by the registry.
 *
 * - `AnyIsomorphicTool`: Framework isomorphic tools
 * - `CoreToolFactory`: @sweatpants/core tools (automatically adapted)
 */
export type ToolInput = AnyIsomorphicTool | CoreToolFactory

/**
 * Create an isomorphic tool registry.
 *
 * Accepts both framework isomorphic tools and @sweatpants/core tools.
 * Core tools are automatically adapted to the isomorphic tool interface.
 *
 * @example
 * ```typescript
 * import { createTool } from '@sweatpants/core'
 *
 * // Core tool
 * const ProcessData = createTool({
 *   name: 'process_data',
 *   description: 'Process data',
 *   input: z.object({ id: z.string() }),
 *   output: z.object({ result: z.string() }),
 *   impl: function* ({ id }) {
 *     return { result: 'done' }
 *   },
 * })
 *
 * // Mix core and isomorphic tools
 * const registry = createIsomorphicToolRegistry([
 *   ProcessData,      // Core tool (adapted automatically)
 *   drawCardTool,     // Framework isomorphic tool
 *   confirmSeenTool,  // Framework isomorphic tool
 * ])
 *
 * // Get schemas for LLM
 * const schemas = registry.toToolSchemas()
 *
 * // Get server tools for executor
 * const serverTools = registry.toServerTools()
 * ```
 */
export function createIsomorphicToolRegistry(
  tools: ToolInput[]
): IsomorphicToolRegistry {
  const map = new Map<string, AnyIsomorphicTool>()

  for (const tool of tools) {
    // Normalize core tools to isomorphic interface
    const normalized = isCoreToolFactory(tool)
      ? adaptCoreTool(tool)
      : tool

    if (map.has(normalized.name)) {
      throw new Error(`Duplicate tool name: ${normalized.name}`)
    }
    map.set(normalized.name, normalized)
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
