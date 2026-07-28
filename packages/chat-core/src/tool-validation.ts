/**
 * chat-core/tool-validation.ts
 *
 * Tool parameter validation error types — pure data interfaces shared
 * between chat-core (streaming events) and framework (tool-parameters module).
 *
 * The ToolParameterValidationError class and validation logic remain in
 * framework because they depend on zod; only the serializable payload
 * types live here.
 */

export const TOOL_PARAMETER_VALIDATION_FAILED = "TOOL_PARAMETER_VALIDATION_FAILED" as const;

export interface ToolParameterValidationIssue {
  path: Array<string | number>;
  message: string;
  code?: string;
  expected?: unknown;
  received?: unknown;
}

export interface ToolParameterValidationErrorPayload {
  code: typeof TOOL_PARAMETER_VALIDATION_FAILED;
  toolName: string;
  callId: string;
  message: string;
  issues: ToolParameterValidationIssue[];
}
