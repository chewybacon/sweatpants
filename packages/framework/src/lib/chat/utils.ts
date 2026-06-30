import { validateToolParameters } from './tool-parameters.ts'

export interface ToolWithParameters {
  name: string
  parameters: unknown
}

export function validateToolParams(
  tool: ToolWithParameters,
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
