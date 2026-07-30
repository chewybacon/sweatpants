import { action, race, type Operation } from "effection";
import { z } from "zod";

import { isDurableToolSessionFacade } from "./durable-tool-session-facade.ts";
import type { AnyToolContract, WireElicitResult, WireSampleResult } from "@sweatpants/agent-sdk";
import type { ToolSession, ToolSessionEvent, ToolSessionRegistry } from "@sweatpants/tool-session";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import {
  type ForeignContinuation,
  type ForeignDurability,
  type ForeignToolContinueRequest,
  type ForeignToolDisposition,
} from "@sweatpants/durable-execution";
import { type DurableEffectRegistration } from "@sweatpants/durable-effects";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  FOREIGN_TOOL_CONTINUE_EFFECT,
  FOREIGN_TOOL_START_EFFECT,
} from "@sweatpants/tool-session/foreign";

const CONTINUATION_SCHEME = "sweatpants/tool-session-v1";

const foreignDurabilitySchema = z.enum([
  "opaque",
  "ephemeral_handle",
  "resumable_handle",
  "server_task",
  "crank_native",
]);

const continuationStateSchema = z.strictObject({
  scheme: z.literal(CONTINUATION_SCHEME),
  sessionId: z.string().min(1),
  afterLsn: z.number().int(),
  pending: z.strictObject({
    kind: z.enum(["sample", "elicit"]),
    requestId: z.string().min(1),
  }),
  durability: foreignDurabilitySchema,
});

type ToolSessionContinuationState = z.infer<typeof continuationStateSchema>;

const samplingToolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.json()),
});

const sampleBaseFields = {
  text: z.string(),
  model: z.string().optional(),
  stopReason: z.string().optional(),
  // Historical model adapters include these bounded transcript fields. They
  // are accepted at this compatibility seam but are not forwarded.
  calls: z.array(z.json()).max(256).optional(),
  content: z.array(z.json()).max(256).optional(),
};

const sampleResponseSchema = z.union([
  z.strictObject({ ...sampleBaseFields, toolCalls: z.array(samplingToolCallSchema) }),
  z.strictObject({
    ...sampleBaseFields,
    parsed: z.json(),
    parseError: z.strictObject({ message: z.string(), rawText: z.string() }).optional(),
  }),
  z.strictObject(sampleBaseFields),
]);

const elicitResponseSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), content: z.json() }),
  z.strictObject({ action: z.literal("decline"), reason: z.string().optional() }),
  z.strictObject({ action: z.literal("cancel"), reason: z.string().optional() }),
]);

/** Scoped ToolSession registry and immutable authored-tool inventory used by the adapter. */
export interface ToolSessionForeignDriverOptions {
  registry: ToolSessionRegistry;
  tools: ReadonlyMap<string, AnyToolContract>;
}

/**
 * Creates start/continue registrations that own ToolSession acquisition, response
 * parsing, cancellation, and release. Expected protocol failures are dispositions.
 */
export function createToolSessionForeignEffectRegistrations(
  options: ToolSessionForeignDriverOptions,
): readonly [DurableEffectRegistration, DurableEffectRegistration] {
  const start = createDurableEffectRegistration(
    FOREIGN_TOOL_START_EFFECT,
    { mode: "unsafe" },
    successfulEffect(function* (request, context) {
      if (request.driver !== "tool-session") {
        return failure(
          request.durability,
          "foreign_driver_mismatch",
          `ToolSession driver cannot handle ${request.driver}`,
        );
      }
      const tool = options.tools.get(request.tool);
      if (!tool) {
        return failure(
          request.durability,
          "foreign_tool_not_found",
          `Foreign tool not found: ${request.tool}`,
        );
      }
      const toolInput = isDurableToolSessionFacade(tool)
        ? { invocationId: context.taskId, input: request.input }
        : request.input;
      let session: ToolSession;
      try {
        session = yield* options.registry.create(tool, toolInput, {
          sessionId: foreignSessionId(context.sessionId, context.taskId),
        });
      } catch {
        return failure(
          request.durability,
          "foreign_session_create_failed",
          "Foreign ToolSession creation failed",
        );
      }
      let disposition: ForeignToolDisposition;
      try {
        // Registry creation must publish a fully initialized session before the
        // durable adapter begins consuming events. Reading status is the
        // readiness barrier shared by worker and remote registries.
        yield* session.status();
        disposition = yield* nextDispositionWithCancellation(
          session,
          0,
          request.durability,
          context.cancellation,
        );
      } catch {
        return failure(
          request.durability,
          "foreign_session_read_failed",
          "Foreign ToolSession event read failed",
        );
      }
      if (disposition.type !== "input_required") {
        try {
          yield* options.registry.release(session.id);
        } catch {
          return failure(
            request.durability,
            "foreign_session_release_failed",
            "Foreign ToolSession release failed",
          );
        }
      }
      return disposition;
    }),
  );

  const continueRegistration = createDurableEffectRegistration(
    FOREIGN_TOOL_CONTINUE_EFFECT,
    { mode: "unsafe" },
    successfulEffect(function* (request, context) {
      const continuation = decodeContinuation(request.continuation);
      if (!continuation) {
        return failure(
          "ephemeral_handle",
          "foreign_continuation_invalid",
          "ToolSession continuation is invalid",
        );
      }
      const session = yield* options.registry.get(continuation.sessionId);
      if (!session) {
        return failure(
          continuation.durability,
          "foreign_continuation_lost",
          `ToolSession ${continuation.sessionId} is unavailable`,
        );
      }
      if (request.response.kind === "cancel") {
        yield* session.cancel("durable program cancelled");
        yield* options.registry.release(session.id);
        return failure(
          continuation.durability,
          "foreign_tool_cancelled",
          "Foreign tool was cancelled",
        );
      }
      const mismatch = continuation.pending.kind !== request.response.kind;
      if (mismatch) {
        return failure(
          continuation.durability,
          "foreign_response_kind_mismatch",
          `Expected ${continuation.pending.kind}, received ${request.response.kind}`,
        );
      }
      const responseFailure = yield* deliverResponse(session, continuation, request);
      if (responseFailure) {
        yield* session.cancel("invalid foreign continuation response");
        yield* options.registry.release(session.id);
        return responseFailure;
      }
      const disposition = yield* nextDispositionWithCancellation(
        session,
        continuation.afterLsn,
        continuation.durability,
        context.cancellation,
      );
      if (disposition.type !== "input_required") {
        yield* options.registry.release(session.id);
      }
      return disposition;
    }),
  );

  return [start, continueRegistration];
}

function* nextDispositionWithCancellation(
  session: ToolSession,
  afterLsn: number,
  durability: ForeignDurability,
  signal: AbortSignal,
): Operation<ForeignToolDisposition> {
  return yield* race([
    nextDisposition(session, afterLsn, durability),
    (function* () {
      if (!signal.aborted) {
        yield* action<void>((resolve) => {
          const onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
          return () => signal.removeEventListener("abort", onAbort);
        });
      }
      try {
        yield* session.cancel("durable program cancelled");
      } catch {
        // The durable cancellation remains authoritative if best-effort live
        // signalling races terminal ToolSession cleanup.
      }
      return failure(durability, "foreign_tool_cancelled", "Foreign tool was cancelled");
    })(),
  ]);
}

function successfulEffect<I extends Json, O extends Json>(
  handler: (input: I, context: Parameters<DurableEffectRegistration["handler"]>[1]) => Operation<O>,
): (
  input: I,
  context: Parameters<DurableEffectRegistration["handler"]>[1],
) => Operation<{ status: "ok"; value: O }> {
  return function* (input, context) {
    return { status: "ok", value: yield* handler(input, context) };
  };
}

function* deliverResponse(
  session: ToolSession,
  continuation: ToolSessionContinuationState,
  request: ForeignToolContinueRequest,
): Operation<ForeignToolDisposition | undefined> {
  if (request.response.kind === "cancel") {
    return failure(continuation.durability, "foreign_tool_cancelled", "Foreign tool was cancelled");
  }
  if (request.response.kind === "sample") {
    const response = decodeSampleResponse(request.response.value);
    if (!response) {
      return failure(
        continuation.durability,
        "foreign_sample_response_invalid",
        "Foreign sample response is invalid",
      );
    }
    yield* session.respondToSample(continuation.pending.requestId, response);
    return undefined;
  }
  const response = decodeElicitResponse(request.response.value);
  if (!response) {
    return failure(
      continuation.durability,
      "foreign_elicit_response_invalid",
      "Foreign elicitation response is invalid",
    );
  }
  yield* session.respondToElicit(continuation.pending.requestId, response);
  return undefined;
}

function* nextDisposition(
  session: ToolSession,
  afterLsn: number,
  durability: ForeignDurability,
): Operation<ForeignToolDisposition> {
  const events = yield* session.events(afterLsn);
  while (true) {
    const next = yield* events.next();
    if (next.done) {
      return failure(
        durability,
        "foreign_session_ended",
        `ToolSession ${session.id} ended without a terminal event`,
      );
    }
    const disposition = eventDisposition(session, next.value, durability);
    if (disposition) {
      return disposition;
    }
  }
}

function eventDisposition(
  session: ToolSession,
  event: ToolSessionEvent,
  durability: ForeignDurability,
): ForeignToolDisposition | undefined {
  switch (event.type) {
    case "progress":
    case "log":
    case "sample_response_queued":
      return undefined;
    case "sample_request":
      return {
        type: "input_required",
        request: {
          kind: "sample",
          payload: foreignJson({
            messages: event.messages,
            ...(event.systemPrompt !== undefined ? { systemPrompt: event.systemPrompt } : {}),
            ...(event.maxTokens !== undefined ? { maxTokens: event.maxTokens } : {}),
            ...(event.modelPreferences !== undefined
              ? { modelPreferences: event.modelPreferences }
              : {}),
            ...(event.tools !== undefined ? { tools: event.tools } : {}),
            ...(event.toolChoice !== undefined ? { toolChoice: event.toolChoice } : {}),
            ...(event.schema !== undefined ? { schema: event.schema } : {}),
          }),
        },
        continuation: createContinuation(
          session.id,
          event.lsn,
          "sample",
          event.sampleId,
          durability,
        ),
      };
    case "elicit_request":
      return {
        type: "input_required",
        request: {
          kind: "elicit",
          key: event.key,
          message: event.message,
          responseSchema: foreignJson(event.schema),
          ...(event.context !== undefined ? { context: foreignJson(event.context) } : {}),
        },
        continuation: createContinuation(
          session.id,
          event.lsn,
          "elicit",
          event.elicitId,
          durability,
        ),
      };
    case "result":
      return { type: "completed", result: foreignJson(event.result) };
    case "error":
      return failure(durability, "foreign_tool_error", event.message);
    case "cancelled":
      return failure(
        durability,
        "foreign_tool_cancelled",
        event.reason ?? "Foreign tool was cancelled",
      );
  }
}

function createContinuation(
  sessionId: string,
  afterLsn: number,
  kind: "sample" | "elicit",
  requestId: string,
  durability: ForeignDurability,
): ForeignContinuation {
  return {
    driver: "tool-session",
    state: {
      scheme: CONTINUATION_SCHEME,
      sessionId,
      afterLsn,
      pending: { kind, requestId },
      durability,
    },
  };
}

function decodeContinuation(value: ForeignContinuation): ToolSessionContinuationState | undefined {
  if (value.driver !== "tool-session") return undefined;
  return continuationStateSchema.safeParse(value.state).data;
}

function decodeSampleResponse(value: Json): WireSampleResult | undefined {
  const result = sampleResponseSchema.safeParse(value);
  if (!result.success) return undefined;
  const response = result.data;
  const base = {
    text: response.text,
    ...(response.model !== undefined ? { model: response.model } : {}),
    ...(response.stopReason !== undefined ? { stopReason: response.stopReason } : {}),
  };
  if ("toolCalls" in response) return { ...base, toolCalls: response.toolCalls };
  if ("parsed" in response) {
    return {
      ...base,
      parsed: response.parsed,
      ...(response.parseError !== undefined ? { parseError: response.parseError } : {}),
    };
  }
  return base;
}

function decodeElicitResponse(value: Json): WireElicitResult<unknown> | undefined {
  const result = elicitResponseSchema.safeParse(value);
  if (!result.success) return undefined;
  const response = result.data;
  if (response.action === "accept") return response;
  return {
    action: response.action,
    ...(response.reason !== undefined ? { reason: response.reason } : {}),
  };
}

function failure(
  durability: ForeignDurability,
  code: string,
  message: string,
): ForeignToolDisposition {
  return {
    type: "failed",
    error: { code, message, durability, retryable: false },
  };
}

function foreignSessionId(sessionId: string, taskId: string): string {
  return `foreign:${sessionId}:${taskId}`;
}

function foreignJson(value: unknown): Json {
  return assertJson(stripUndefined(value));
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, stripUndefined(child)]),
    );
  }
  return value;
}
