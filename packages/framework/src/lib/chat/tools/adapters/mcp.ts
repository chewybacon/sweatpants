/**
 * MCP Tool Adapter
 *
 * Converts unified tool format to MCP tool format for runtime compatibility.
 * This allows tools created with createTool() to work with the existing
 * mcp-tools runtime infrastructure.
 *
 * @packageDocumentation
 */
import type { z } from 'zod'
import type { FinalizedTool, ElicitsMap } from '../types.ts'
import type {
  FinalizedMcpToolWithElicits,
} from '../../mcp-tools/mcp-tool-builder.ts'
import type {
  ElicitsMap as McpElicitsMap,
} from '../../mcp-tools/mcp-tool-types.ts'

/**
 * Convert elicits from unified format to MCP format.
 *
 * Unified: `{ key: z.ZodType }`
 * MCP: `{ key: { response: z.ZodType } }`
 */
function convertElicits<T extends ElicitsMap>(elicits: T): McpElicitsMap {
  const mcpElicits: McpElicitsMap = {}
  for (const [key, schema] of Object.entries(elicits)) {
    mcpElicits[key] = { response: schema as z.ZodType }
  }
  return mcpElicits
}

/**
 * Convert a unified tool to MCP tool format.
 *
 * This enables tools created with the new `createTool()` builder
 * to work with the existing mcp-tools runtime.
 *
 * Note: Uses type assertions because the unified types are structurally
 * compatible but not nominally identical to MCP types.
 */
export function toMcpTool<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
>(
  tool: FinalizedTool<TName, TParams, THandoff, TClient, TResult, TElicits>
): FinalizedMcpToolWithElicits<TName, TParams, THandoff, TClient, TResult, McpElicitsMap> {
  const mcpElicits = convertElicits(tool.elicits)

  // Build the base tool object
  const baseTool = {
    _types: undefined as any,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    elicits: mcpElicits,
    ...(tool.limits && { limits: tool.limits }),
  }

  if (tool.mode === 'execute' && tool.execute) {
    return {
      ...baseTool,
      execute: tool.execute as any,
    } as FinalizedMcpToolWithElicits<TName, TParams, THandoff, TClient, TResult, McpElicitsMap>
  }

  if (tool.mode === 'handoff' && tool.handoffConfig) {
    return {
      ...baseTool,
      handoffConfig: {
        before: tool.handoffConfig.before as any,
        client: tool.handoffConfig.client as any,
        after: tool.handoffConfig.after as any,
      },
    } as FinalizedMcpToolWithElicits<TName, TParams, THandoff, TClient, TResult, McpElicitsMap>
  }

  throw new Error(`Tool "${tool.name}" has invalid mode: ${tool.mode}`)
}

/**
 * Check if a tool is in unified format.
 */
export function isUnifiedTool(tool: unknown): tool is FinalizedTool<string, any, any, any, any, ElicitsMap> {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    'mode' in tool &&
    (tool.mode === 'execute' || tool.mode === 'handoff')
  )
}

/**
 * Check if a unified tool requires the MCP runtime.
 * 
 * A tool needs the MCP runtime if:
 * - It has elicitation keys defined (non-empty elicits map)
 * - It uses handoff mode (which implies client/sampling interaction)
 * 
 * Simple execute-only tools without elicits can run through a minimal runtime.
 */
export function needsMcpRuntime(tool: FinalizedTool<string, any, any, any, any, ElicitsMap>): boolean {
  // Check for elicitation keys
  const hasElicits = Object.keys(tool.elicits).length > 0
  
  // Handoff mode always needs MCP runtime
  const isHandoff = tool.mode === 'handoff'
  
  return hasElicits || isHandoff
}

/**
 * Check if a tool is a simple execute-only tool that doesn't need full MCP runtime.
 * These tools can be executed with a minimal context.
 */
export function isSimpleExecuteTool(tool: FinalizedTool<string, any, any, any, any, ElicitsMap>): boolean {
  return tool.mode === 'execute' && !needsMcpRuntime(tool)
}
