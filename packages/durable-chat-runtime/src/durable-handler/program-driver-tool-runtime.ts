import { parseElicitExchangeCompletion } from "@sweatpants/agent-sdk";
import type { Operation } from "effection";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import {
  type EphemeralDurability,
  type EphemeralToolDisposition,
} from "@sweatpants/durable-execution";
import {
  type DurableEffectContext,
  type DurableEffectRegistration,
} from "@sweatpants/durable-effects";
import { assertJson, type Json } from "@sweatpants/foundation";
import { z } from "zod";
import {
  EPHEMERAL_TOOL_CONTINUE_EFFECT,
  EPHEMERAL_TOOL_START_EFFECT,
} from "@sweatpants/tool-session/ephemeral";

import type { ToolInventoryEntry } from "@sweatpants/tool-runtime";
import { getToolParameterValidationErrorPayload } from "@sweatpants/tool-session/tool-parameters";
import type {
  ToolExecution,
  ToolExecutionEvent,
  ToolExecutionRef,
  ToolRuntime,
} from "@sweatpants/tool-runtime";

const DRIVER = "chat-tool-runtime";
const DURABILITY: EphemeralDurability = "ephemeral_handle";
const continuationSchema = z.strictObject({
  ref: z
    .strictObject({
      runtimeId: z.string().min(1).max(512),
      executionId: z.string().min(1).max(512),
      callId: z.string().min(1).max(512),
      toolName: z.string().min(1).max(512),
      sessionId: z.string().max(512).optional(),
    })
    .transform(
      (value): ToolExecutionRef => ({
        runtimeId: value.runtimeId,
        executionId: value.executionId,
        callId: value.callId,
        toolName: value.toolName,
        ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
      }),
    ),
  tool: z.string().max(512),
  elicitId: z.string().max(512),
});

type ToolRuntimeEphemeralOptions = {
  runtime: ToolRuntime;
  entries: readonly ToolInventoryEntry[];
  threadId: string;
  runId: string;
};

/**
 * Adapts framework ToolRuntime calls to the durable ephemeral-effect contract.
 * Sampling-capable inventory entries are rejected because ToolRuntime currently
 * hides their sampling continuation; callers must install the ToolSession-native
 * ephemeral registrations for those tools instead.
 */
export function createToolRuntimeEphemeralEffectRegistrations(
  options: ToolRuntimeEphemeralOptions,
): readonly [DurableEffectRegistration, DurableEffectRegistration] {
  const start = createDurableEffectRegistration(
    EPHEMERAL_TOOL_START_EFFECT,
    { mode: "unsafe" },
    successfulEffect(function* (request, context): Operation<EphemeralToolDisposition> {
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
            name: request.tool,
            input: request.input,
            thoughtSignature: null,
          },
          signal: context.cancellation,
          metadata: effectMetadata(options, context),
        });
        return yield* disposition(execution, request.tool, options.runtime, entry);
      } catch (error) {
        if (context.cancellation.aborted) {
          return failure("foreign_tool_cancelled", "Ephemeral tool was cancelled");
        }
        const validation = getToolParameterValidationErrorPayload(error);
        return validation
          ? failure(validation.code, validation.message)
          : failure("foreign_tool_start_failed", "Ephemeral tool start failed");
      }
    }),
  );

  const continueRegistration = createDurableEffectRegistration(
    EPHEMERAL_TOOL_CONTINUE_EFFECT,
    { mode: "unsafe" },
    successfulEffect(function* (request, context): Operation<EphemeralToolDisposition> {
      if (request.continuation.driver !== DRIVER) {
        return failure("foreign_continuation_invalid", "Ephemeral continuation is invalid");
      }
      const parsed = parseContinuation(request.continuation.state);
      if (!parsed) {
        return failure("foreign_continuation_invalid", "Ephemeral continuation is invalid");
      }
      if (request.response.kind === "cancel") {
        try {
          yield* options.runtime.abort(parsed.ref, "durable program cancelled");
        } catch {
          return failure("foreign_tool_cancel_failed", "Ephemeral tool cancellation failed");
        }
        return failure("foreign_tool_cancelled", "Ephemeral tool was cancelled");
      }
      if (request.response.kind !== "elicit") {
        return failure("foreign_response_kind_mismatch", "Foreign response kind is invalid");
      }
      const parsedCompletion = parseElicitExchangeCompletion(request.response.value);
      if (!parsedCompletion.ok) {
        return failure(
          "foreign_elicit_response_invalid",
          "Ephemeral elicitation response is invalid",
        );
      }
      const completion = parsedCompletion.value;
      try {
        const execution = yield* options.runtime.resume({
          ref: parsed.ref,
          input: {
            type: "elicit_response",
            elicitId: parsed.elicitId,
            completion,
          },
          signal: context.cancellation,
          metadata: effectMetadata(options, context),
        });
        const entry = options.entries.find(
          (candidate) => candidate.definition.name === parsed.tool,
        );
        return yield* disposition(execution, parsed.tool, options.runtime, entry);
      } catch {
        return context.cancellation.aborted
          ? failure("foreign_tool_cancelled", "Ephemeral tool was cancelled")
          : failure("foreign_tool_continue_failed", "Ephemeral tool continuation failed");
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
  entry?: ToolInventoryEntry,
): Operation<EphemeralToolDisposition> {
  switch (execution.kind) {
    case "completed":
      try {
        return { type: "completed", result: assertJson(execution.result) };
      } catch {
        return failure("foreign_result_not_json", "Ephemeral tool returned a non-JSON result");
      }
    case "failed":
      return failure(execution.error.code ?? "foreign_tool_failed", execution.error.message);
    case "awaiting_elicit":
      return inputRequired(execution.ref, tool, execution.request, entry);
    case "running": {
      const events = yield* execution.events;
      while (true) {
        const next = yield* events.next();
        if (next.done) {
          return failure("foreign_session_ended", "Ephemeral tool ended without a result");
        }
        const mapped = mapEvent(next.value, execution.ref, tool, entry);
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
  entry?: ToolInventoryEntry,
): EphemeralToolDisposition | undefined {
  switch (event.type) {
    case "progress":
    case "log":
    case "sample_response_queued":
      return undefined;
    case "result":
      try {
        return { type: "completed", result: assertJson(event.result) };
      } catch {
        return failure("foreign_result_not_json", "Ephemeral tool returned a non-JSON result");
      }
    case "error":
      return failure(event.code ?? "foreign_tool_failed", event.message);
    case "cancelled":
      return failure("foreign_tool_cancelled", event.reason ?? "Ephemeral tool was cancelled");
    case "elicit_request":
      return inputRequired(ref, tool, event, entry);
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
    context?: Json;
    binding?: { readonly id: string };
  },
  entry?: ToolInventoryEntry,
): EphemeralToolDisposition {
  try {
    const binding = request.binding ?? entry?.elicits?.[request.key]?.binding;
    if (!binding) {
      return failure(
        "interaction_binding_missing",
        `Tool "${tool}" omitted binding for elicitation "${request.key}"`,
      );
    }
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
          ...(request.context !== undefined ? { context: request.context } : {}),
        }),
        binding,
      },
      continuation: {
        driver: DRIVER,
        state: assertJson({ ref, tool, elicitId: request.elicitId }),
      },
    };
  } catch {
    return failure("foreign_elicit_not_json", "Ephemeral elicitation is not canonical JSON");
  }
}

function parseContinuation(
  value: Json,
): { ref: ToolExecutionRef; tool: string; elicitId: string } | undefined {
  return continuationSchema.safeParse(value).data;
}

function effectMetadata(options: ToolRuntimeEphemeralOptions, context: DurableEffectContext) {
  return {
    threadId: options.threadId,
    runId: options.runId,
    pullId: context.pullId,
    attemptId: context.attemptId,
  };
}

function failure(code: string, message: string): EphemeralToolDisposition {
  return {
    type: "failed",
    error: { code, message, durability: DURABILITY, retryable: false },
  };
}
