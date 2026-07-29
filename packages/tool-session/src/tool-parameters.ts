import type { AnyToolContract } from "@sweatpants/agent-sdk";
import { z } from "zod";

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

type SafeParseResult<T> = { success: true; data: T } | { success: false; error?: unknown };

type SafeParseSchema<T> = {
  safeParse(input: unknown): SafeParseResult<T>;
};

type ParseSchema<T> = {
  parse(input: unknown): T;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    isRecord(value) &&
    (typeof (value as { safeParse?: unknown }).safeParse === "function" ||
      (typeof (value as { parse?: unknown }).parse === "function" && "_def" in value))
  );
}

function stripNonJson(value: unknown): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(stripNonJson).filter((entry) => entry !== undefined);
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalized = stripNonJson(entry);
      if (normalized !== undefined) {
        result[key] = normalized;
      }
    }
    return result;
  }

  return value;
}

function schemaHasSafeParse<T>(schema: unknown): schema is SafeParseSchema<T> {
  return (
    !!schema &&
    typeof schema === "object" &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

function schemaHasParse<T>(schema: unknown): schema is ParseSchema<T> {
  return (
    !!schema &&
    typeof schema === "object" &&
    typeof (schema as { parse?: unknown }).parse === "function"
  );
}

function issuePath(value: unknown): Array<string | number> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (part): part is string | number => typeof part === "string" || typeof part === "number",
  );
}

function normalizeValidationIssues(error: unknown): ToolParameterValidationIssue[] {
  const rawIssues =
    isRecord(error) && Array.isArray(error["issues"])
      ? error["issues"]
      : isRecord(error) && Array.isArray(error["errors"])
        ? error["errors"]
        : [];

  return rawIssues.map((issue): ToolParameterValidationIssue => {
    const record = isRecord(issue) ? issue : {};
    return {
      path: issuePath(record["path"]),
      message: typeof record["message"] === "string" ? record["message"] : "Invalid value",
      ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
      ...("expected" in record ? { expected: record["expected"] } : {}),
      ...("received" in record ? { received: record["received"] } : {}),
    };
  });
}

function validationMessage(
  toolName: string,
  issues: ToolParameterValidationIssue[],
  fallback?: string,
): string {
  const summary =
    issues.length > 0
      ? issues
          .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
            return `${path}: ${issue.message}`;
          })
          .join("; ")
      : (fallback ?? "parameter validation failed");

  return `Invalid parameters for tool "${toolName}": ${summary}`;
}

export function createToolParameterValidationError(input: {
  toolName: string;
  callId: string;
  cause?: unknown;
}): ToolParameterValidationError {
  const issues = normalizeValidationIssues(input.cause);
  const fallback = input.cause instanceof Error ? input.cause.message : undefined;
  const payload: ToolParameterValidationErrorPayload = {
    code: TOOL_PARAMETER_VALIDATION_FAILED,
    toolName: input.toolName,
    callId: input.callId,
    message: validationMessage(input.toolName, issues, fallback),
    issues,
  };
  return new ToolParameterValidationError(payload, { cause: input.cause });
}

export function getToolParameterValidationErrorPayload(
  error: unknown,
): ToolParameterValidationErrorPayload | undefined {
  if (error instanceof ToolParameterValidationError) {
    return error.payload;
  }
  if (!isRecord(error)) {
    return undefined;
  }

  const code = error["code"];
  const payload = error["payload"];
  if (code === TOOL_PARAMETER_VALIDATION_FAILED && isRecord(payload)) {
    const toolName = typeof payload["toolName"] === "string" ? payload["toolName"] : undefined;
    const callId = typeof payload["callId"] === "string" ? payload["callId"] : undefined;
    const message = typeof payload["message"] === "string" ? payload["message"] : undefined;
    if (toolName && callId && message) {
      return {
        code: TOOL_PARAMETER_VALIDATION_FAILED,
        toolName,
        callId,
        message,
        issues: Array.isArray(payload["issues"])
          ? payload["issues"].map((issue) => {
              const record = isRecord(issue) ? issue : {};
              return {
                path: issuePath(record["path"]),
                message:
                  typeof record["message"] === "string" ? record["message"] : "Invalid value",
                ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
                ...("expected" in record ? { expected: record["expected"] } : {}),
                ...("received" in record ? { received: record["received"] } : {}),
              };
            })
          : [],
      };
    }
  }

  return undefined;
}

export function validateToolParameters<T = unknown>(input: {
  schema: unknown;
  params: unknown;
  toolName: string;
  callId: string;
}): T {
  const { schema, params, toolName, callId } = input;

  if (schemaHasSafeParse<T>(schema)) {
    let result: SafeParseResult<T>;
    try {
      result = schema.safeParse(params);
    } catch (cause) {
      throw createToolParameterValidationError({ toolName, callId, cause });
    }

    if (!result.success || result.data === undefined) {
      throw createToolParameterValidationError({
        toolName,
        callId,
        cause: result.success ? undefined : result.error,
      });
    }
    return result.data;
  }

  if (schemaHasParse<T>(schema)) {
    try {
      return schema.parse(params);
    } catch (cause) {
      throw createToolParameterValidationError({ toolName, callId, cause });
    }
  }

  return params as T;
}

export function validateRuntimeToolParameters<T = unknown>(
  tool: Pick<AnyToolContract, "name" | "parameters">,
  params: unknown,
  callId: string,
): T {
  return validateToolParameters<T>({
    schema: tool.parameters,
    params,
    toolName: tool.name,
    callId,
  });
}

export function toToolParameterJsonSchema(schema: unknown): Record<string, unknown> {
  if (isZodSchema(schema)) {
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
    return stripNonJson(jsonSchema) as Record<string, unknown>;
  }

  if (isRecord(schema)) {
    return stripNonJson(schema) as Record<string, unknown>;
  }

  return { type: "object", properties: {}, required: [] };
}
