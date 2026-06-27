import type { AnyIsomorphicTool } from './isomorphic-tools/types.ts'
import { validateToolParameters } from './tool-parameters.ts'

/**
 * Validate tool parameters using the tool's declared schema.
 *
 * @param tool - The isomorphic tool with parameter schema
 * @param params - The parameters to validate
 * @param callId - The correlated model tool-call id
 * @returns The validated parameters
 * @throws ToolParameterValidationError if validation fails
 */
export function validateToolParams(
  tool: AnyIsomorphicTool,
  params: unknown,
  callId = tool.name,
): unknown {
  return validateToolParameters({
    schema: tool.parameters,
    params,
    toolName: tool.name,
    callId,
  })
}
