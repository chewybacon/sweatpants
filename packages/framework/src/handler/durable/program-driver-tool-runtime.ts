import type { Operation } from "effection";
import { createDurableEffectRegistration } from "@sweatpants/session-contract";
import {
  FOREIGN_TOOL_CONTINUE_EFFECT,
  FOREIGN_TOOL_START_EFFECT,
  assertJson,
  type DurableEffectContext,
  type DurableEffectRegistration,
  type ForeignDurability,
  type ForeignToolDisposition,
  type Json,
} from "@sweatpants/session-contract";

import type { ToolInventoryEntry } from "../../lib/chat/tool-inventory.ts";
import { getToolParameterValidationErrorPayload } from "../../lib/chat/tool-parameters.ts";
import type {
  ToolExecution,
  ToolExecutionEvent,
  ToolExecutionRef,
  ToolRuntime,
} from "../../lib/chat/tool-runtime.ts";

const DRIVER = "framework-tool-runtime";
const DURABILITY: ForeignDurability = "ephemeral_handle";

type ToolRuntimeForeignOptions = {
  runtime: ToolRuntime;
  entries: readonly ToolInventoryEntry[];
  threadId: string;
  runId: string;
};

/**
 * Adapts framework ToolRuntime calls to the durable foreign-effect contract.
 * Sampling-capable inventory entries are rejected because ToolRuntime currently
 * hides their sampling continuation; callers must install the ToolSession-native
 * foreign registrations for those tools instead.
 */
export function createToolRuntimeForeignEffectRegistrations(
  options: ToolRuntimeForeignOptions,
): readonly [DurableEffectRegistration, DurableEffectRegistration] {
  const start = createDurableEffectRegistration(
    FOREIGN_TOOL_START_EFFECT,
    { mode: "unsafe" },
    successfulEffect(function* (request, context): Operation<ForeignToolDisposition> {
      if (request.driver !== DRIVER) {
        return failure("foreign_driver_mismatch", `Unsupported foreign driver: ${request.driver}`);
      }
      const entry = options.entries.find((candidate) => candidate.definition.name === request.tool);
      if (!entry) {
        return failure("foreign_tool_not_found", `Tool not found: ${request.tool}`);
      }
      if (entry.capabilities?.samples === true) {
        return failure(
          "foreign_sampling_driver_required",
          `Tool requires a sampling-aware foreign driver: ${request.tool}`,
        );
      }
      try {
        const execution = yield* options.runtime.execute({
          entry,
          call: {
            id: request.route ?? `${context.taskId}:${context.pullId}`,
            type: "function",
            function: { name: request.tool, arguments: objectInput(request.input) },
          },
          signal: context.cancellation,
          metadata: effectMetadata(options, context),
        });
        return yield* disposition(execution, request.tool, options.runtime);
      } catch (error) {
        if (context.cancellation.aborted) {
          return failure("foreign_tool_cancelled", "Foreign tool was cancelled");
        }
        const validation = getToolParameterValidationErrorPayload(error);
        return validation
          ? failure(validation.code, validation.message)
          : failure("foreign_tool_start_failed", "Foreign tool start failed");
      }
    }),
  );

  const continueRegistration = createDurableEffectRegistration(
    FOREIGN_TOOL_CONTINUE_EFFECT,
    { mode: "unsafe" },
    successfulEffect(function* (request, context): Operation<ForeignToolDisposition> {
      if (request.continuation.driver !== DRIVER) {
        return failure("foreign_continuation_invalid", "Foreign continuation is invalid");
      }
      const parsed = parseContinuation(request.continuation.state);
      if (!parsed) {
        return failure("foreign_continuation_invalid", "Foreign continuation is invalid");
      }
      if (request.response.kind === "cancel") {
        try {
          yield* options.runtime.abort(parsed.ref, "durable program cancelled");
        } catch {
          return failure("foreign_tool_cancel_failed", "Foreign tool cancellation failed");
        }
        return failure("foreign_tool_cancelled", "Foreign tool was cancelled");
      }
      if (request.response.kind !== "elicit") {
        return failure("foreign_response_kind_mismatch", "Foreign response kind is invalid");
      }
      try {
        const execution = yield* options.runtime.resume({
          ref: parsed.ref,
          input: {
            type: "elicit_response",
            elicitId: parsed.elicitId,
            result: request.response.value,
          },
          signal: context.cancellation,
          metadata: effectMetadata(options, context),
        });
        return yield* disposition(execution, parsed.tool, options.runtime);
      } catch {
        return context.cancellation.aborted
          ? failure("foreign_tool_cancelled", "Foreign tool was cancelled")
          : failure("foreign_tool_continue_failed", "Foreign tool continuation failed");
      }
    }),
  );

  return [start, continueRegistration];
}

function successfulEffect<I extends Json, O extends Json>(
  handler: (input: I, context: DurableEffectContext) => Operation<O>,
): (input: I, context: DurableEffectContext) => Operation<{ status: "ok"; value: O }> {
  return function* (input, context) {
    return { status: "ok", value: yield* handler(input, context) };
  };
}

function* disposition(
  execution: ToolExecution,
  tool: string,
  runtime: ToolRuntime,
): Operation<ForeignToolDisposition> {
  switch (execution.kind) {
    case "completed":
      try {
        return { type: "completed", result: assertJson(execution.result) };
      } catch {
        return failure("foreign_result_not_json", "Foreign tool returned a non-JSON result");
      }
    case "failed":
      return failure(execution.error.code ?? "foreign_tool_failed", execution.error.message);
    case "awaiting_elicit":
      return inputRequired(execution.ref, tool, execution.request);
    case "running": {
      const events = yield* execution.events;
      while (true) {
        const next = yield* events.next();
        if (next.done) {
          return failure("foreign_session_ended", "Foreign tool ended without a result");
        }
        const mapped = mapEvent(next.value, execution.ref, tool);
        if (mapped?.type === "failed" && mapped.error.code === "foreign_sampling_driver_required") {
          try {
            yield* runtime.abort(execution.ref, "sampling continuation requires journal lifting");
          } catch {
            // The original durability failure remains authoritative; abort is
            // cooperative cleanup and cannot make hidden sampling replay-safe.
          }
        }
        if (mapped) {
          return mapped;
        }
      }
    }
  }
}

function mapEvent(
  event: ToolExecutionEvent,
  ref: ToolExecutionRef,
  tool: string,
): ForeignToolDisposition | undefined {
  switch (event.type) {
    case "progress":
    case "log":
    case "sample_response_queued":
      return undefined;
    case "result":
      try {
        return { type: "completed", result: assertJson(event.result) };
      } catch {
        return failure("foreign_result_not_json", "Foreign tool returned a non-JSON result");
      }
    case "error":
      return failure(event.code ?? "foreign_tool_failed", event.message);
    case "cancelled":
      return failure("foreign_tool_cancelled", event.reason ?? "Foreign tool was cancelled");
    case "elicit_request":
      return inputRequired(ref, tool, event);
    case "sample_request":
      return failure(
        "foreign_sampling_driver_required",
        "ToolRuntime exposed sampling without a journal-aware continuation driver",
      );
  }
}

function inputRequired(
  ref: ToolExecutionRef,
  tool: string,
  request: {
    elicitId: string;
    key: string;
    message: string;
    schema: Record<string, unknown>;
    context?: Record<string, unknown>;
  },
): ForeignToolDisposition {
  try {
    return {
      type: "input_required",
      request: {
        kind: "elicit",
        key: request.key,
        message: request.message,
        responseSchema: assertJson(request.schema),
        context: assertJson({
          callId: ref.callId,
          elicitId: request.elicitId,
          toolName: tool,
          ...request.context,
        }),
      },
      continuation: {
        driver: DRIVER,
        state: assertJson({ ref, tool, elicitId: request.elicitId }),
      },
    };
  } catch {
    return failure("foreign_elicit_not_json", "Foreign elicitation is not canonical JSON");
  }
}

function parseContinuation(
  value: Json,
): { ref: ToolExecutionRef; tool: string; elicitId: string } | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["ref", "tool", "elicitId"])) {
    return undefined;
  }
  const ref = value["ref"];
  if (
    !isRecord(ref) ||
    !hasOnlyKeys(ref, ["runtimeId", "executionId", "callId", "toolName"], ["sessionId"])
  ) {
    return undefined;
  }
  const runtimeId = ref["runtimeId"];
  const executionId = ref["executionId"];
  const callId = ref["callId"];
  const toolName = ref["toolName"];
  const sessionId = ref["sessionId"];
  const tool = value["tool"];
  const elicitId = value["elicitId"];
  if (
    typeof runtimeId !== "string" ||
    typeof executionId !== "string" ||
    typeof callId !== "string" ||
    typeof toolName !== "string" ||
    runtimeId.length === 0 ||
    executionId.length === 0 ||
    callId.length === 0 ||
    toolName.length === 0 ||
    (sessionId !== undefined && typeof sessionId !== "string") ||
    typeof tool !== "string" ||
    typeof elicitId !== "string"
  ) {
    return undefined;
  }
  return {
    ref: {
      runtimeId,
      executionId,
      callId,
      toolName,
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
    tool,
    elicitId,
  };
}

function objectInput(value: Json): Record<string, unknown> {
  return isRecord(value) ? value : { input: value };
}

function effectMetadata(options: ToolRuntimeForeignOptions, context: DurableEffectContext) {
  return {
    threadId: options.threadId,
    runId: options.runId,
    pullId: context.pullId,
    attemptId: context.attemptId,
  };
}

function failure(code: string, message: string): ForeignToolDisposition {
  return {
    type: "failed",
    error: { code, message, durability: DURABILITY, retryable: false },
  };
}

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

function hasExactKeys(value: Record<string, Json>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function hasOnlyKeys(
  value: Record<string, Json>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}
