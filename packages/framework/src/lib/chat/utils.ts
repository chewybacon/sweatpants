import type { AnyIsomorphicTool } from './isomorphic-tools/types'

/**
 * Validate tool parameters using Zod schema.
 *
 * @param tool - The isomorphic tool with parameter schema
 * @param params - The parameters to validate
 * @returns The validated parameters
 * @throws Error if validation fails
 */
export function validateToolParams(tool: AnyIsomorphicTool, params: unknown): unknown {
  const parsed = tool.parameters.safeParse(params)
  if (!parsed.success) {
    throw new Error(`Validation failed for tool "${tool.name}": ${parsed.error.message}`)
  }
  return parsed.data
}