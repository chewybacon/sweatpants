import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AnyToolContract } from "@sweatpants/agent-sdk";
import type { Operation } from "effection";
import { z } from "zod";
import { safeSchemaIssues, validateStandardSchema } from "@sweatpants/foundation/schema-validation";

export {
  TOOL_PARAMETER_VALIDATION_FAILED,
  type ToolParameterValidationIssue,
  type ToolParameterValidationErrorPayload,
} from "@sweatpants/agent-sdk/tool";
import {
  TOOL_PARAMETER_VALIDATION_FAILED,
  type ToolParameterValidationIssue,
  type ToolParameterValidationErrorPayload,
} from "@sweatpants/agent-sdk/tool";

export class ToolParameterValidationError extends Error {
  readonly code = TOOL_PARAMETER_VALIDATION_FAILED;
  readonly payload: ToolParameterValidationErrorPayload;

  constructor(payload: ToolParameterValidationErrorPayload, options?: { cause?: unknown }) {
    super(payload.message, options);
    this.name = "ToolParameterValidationError";
    this.payload = payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime authority check for the public Standard Schema contract. */
function isStandardSchema(value: unknown): value is StandardSchemaV1<unknown, unknown> {
  if (!isRecord(value) || !isRecord(value["~standard"])) return false;
  const standard = value["~standard"];
  return standard["version"] === 1 && typeof standard["validate"] === "function";
}

function isZodSchema(value: unknown): value is z.ZodType {
  return isStandardSchema(value) && value["~standard"]["vendor"] === "zod";
}

function stripNonJson(value: unknown): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return value.map(stripNonJson).filter((entry) => entry !== undefined);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalized = stripNonJson(entry);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return value;
}

function issuePath(value: unknown): Array<string | number> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (part): part is string | number => typeof part === "string" || typeof part === "number",
  );
}

function normalizeValidationIssues(error: unknown): ToolParameterValidationIssue[] {
  const rawIssues = Array.isArray(error)
    ? error
    : isRecord(error) && Array.isArray(error["issues"])
      ? error["issues"]
      : isRecord(error) && Array.isArray(error["errors"])
        ? error["errors"]
        : [];

  // Do not copy validator issue records: they may contain rejected values.
  // Public tool errors use the same bounded, value-free projection everywhere.
  return safeSchemaIssues(
    rawIssues.filter(isRecord).map((issue) => ({
      path: issuePath(issue["path"]),
      message: typeof issue["message"] === "string" ? issue["message"] : "Invalid value",
    })),
  ).map((issue) => ({
    path: issue.path
      ? issue.path
          .split(".")
          .filter(Boolean)
          .map((part) => (/^\d+$/u.test(part) ? Number(part) : part))
      : [],
    message: issue.message,
  }));
}

function validationMessage(toolName: string, issues: ToolParameterValidationIssue[]): string {
  const summary =
    issues.length > 0
      ? issues
          .slice(0, 16)
          .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".").slice(0, 256) : "<root>";
            return `${path}: ${issue.message.slice(0, 512)}`;
          })
          .join("; ")
      : "parameter validation failed";
  return `Invalid parameters for tool "${toolName.slice(0, 512)}": ${summary.slice(0, 8_192)}`;
}

export function createToolParameterValidationError(input: {
  toolName: string;
  callId: string;
  cause?: unknown;
}): ToolParameterValidationError {
  const issues = normalizeValidationIssues(input.cause);
  const payload: ToolParameterValidationErrorPayload = {
    code: TOOL_PARAMETER_VALIDATION_FAILED,
    toolName: input.toolName.slice(0, 512),
    callId: input.callId.slice(0, 512),
    message: validationMessage(input.toolName, issues),
    issues,
  };
  // Deliberately do not attach the raw validator exception as `cause`: it may
  // contain the rejected value, provider response, or an unbounded stack.
  return new ToolParameterValidationError(payload);
}

export function getToolParameterValidationErrorPayload(
  error: unknown,
): ToolParameterValidationErrorPayload | undefined {
  if (error instanceof ToolParameterValidationError) return error.payload;
  if (!isRecord(error) || error["code"] !== TOOL_PARAMETER_VALIDATION_FAILED) return undefined;
  const payload = error["payload"];
  if (!isRecord(payload)) return undefined;
  const toolName =
    typeof payload["toolName"] === "string" ? payload["toolName"].slice(0, 512) : undefined;
  const callId =
    typeof payload["callId"] === "string" ? payload["callId"].slice(0, 512) : undefined;
  if (!toolName || !callId) return undefined;
  const issues = normalizeValidationIssues({ issues: payload["issues"] });
  return {
    code: TOOL_PARAMETER_VALIDATION_FAILED,
    toolName,
    callId,
    message: validationMessage(toolName, issues),
    issues,
  };
}

export function* parseToolParameters<T = unknown>(input: {
  schema: StandardSchemaV1<unknown, T>;
  params: unknown;
  toolName: string;
  callId: string;
}): Operation<T> {
  const { schema, params, toolName, callId } = input;
  if (!isStandardSchema(schema)) {
    throw createToolParameterValidationError({ toolName, callId });
  }
  try {
    const result = yield* validateStandardSchema(schema, params);
    if (result.issues !== undefined) {
      throw createToolParameterValidationError({ toolName, callId, cause: result.issues });
    }
    // A successful Standard Schema result may legitimately contain undefined.
    return result.value;
  } catch (cause) {
    if (cause instanceof ToolParameterValidationError) throw cause;
    throw createToolParameterValidationError({ toolName, callId, cause });
  }
}

export function* parseRuntimeToolParameters<T = unknown>(
  tool: Pick<AnyToolContract, "name" | "parameters">,
  params: unknown,
  callId: string,
): Operation<T> {
  return yield* parseToolParameters<T>({
    schema: tool.parameters,
    params,
    toolName: tool.name,
    callId,
  });
}

export function toToolParameterJsonSchema(schema: unknown): Record<string, unknown> {
  if (isStandardSchema(schema)) {
    if (isZodSchema(schema)) {
      const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
      return stripNonJson(jsonSchema) as Record<string, unknown>;
    }
    // Test/integration adapters may carry an explicit projection beside their
    // process-local Standard Schema. It is data-only and safe to send.
    const projection = (schema as StandardSchemaV1 & { jsonSchema?: unknown })["jsonSchema"];
    if (isRecord(projection)) {
      return stripNonJson(projection) as Record<string, unknown>;
    }
    throw new TypeError("Standard Schema requires an explicit JSON Schema projection");
  }
  if (isRecord(schema)) {
    return stripNonJson(schema) as Record<string, unknown>;
  }
  // A missing projection must not silently advertise an unconstrained tool.
  throw new TypeError("Tool parameters require a Standard Schema or JSON Schema projection");
}
