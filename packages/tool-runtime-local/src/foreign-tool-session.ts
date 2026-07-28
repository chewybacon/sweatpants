import { action, race, type Operation } from "effection";

import { isDurableToolSessionFacade } from "./durable-tool-session-facade.ts";
import type { AnyToolContract } from "@sweatpants/core";
import type {
  ToolSession,
  ToolSessionEvent,
  SamplingToolCall,
  ToolSessionRegistry,
  WireElicitResult,
  WireSampleResult,
} from "@sweatpants/tool-session";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import {
  FOREIGN_TOOL_CONTINUE_EFFECT,
  FOREIGN_TOOL_START_EFFECT,
  assertJson,
  type DurableEffectRegistration,
  type ForeignContinuation,
  type ForeignDurability,
  type ForeignToolContinueRequest,
  type ForeignToolDisposition,
  type Json,
} from "@sweatpants/session-contract";

const CONTINUATION_SCHEME = "sweatpants/tool-session-v1";

type ToolSessionContinuationState = {
  scheme: typeof CONTINUATION_SCHEME;
  sessionId: string;
  afterLsn: number;
  pending: { kind: "sample" | "elicit"; requestId: string };
  durability: ForeignDurability;
};

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
  if (value.driver !== "tool-session") {
    return undefined;
  }
  const state = value.state;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return undefined;
  }
  if (state["scheme"] !== CONTINUATION_SCHEME) {
    return undefined;
  }
  const sessionId = state["sessionId"];
  const afterLsn = state["afterLsn"];
  const pending = state["pending"];
  const durability = state["durability"];
  if (
    typeof sessionId !== "string" ||
    typeof afterLsn !== "number" ||
    pending === null ||
    typeof pending !== "object" ||
    Array.isArray(pending) ||
    (pending["kind"] !== "sample" && pending["kind"] !== "elicit") ||
    typeof pending["requestId"] !== "string" ||
    !isForeignDurability(durability)
  ) {
    return undefined;
  }
  return {
    scheme: CONTINUATION_SCHEME,
    sessionId,
    afterLsn,
    pending: { kind: pending["kind"], requestId: pending["requestId"] },
    durability,
  };
}

function decodeSampleResponse(value: Json): WireSampleResult | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const text = value["text"];
  if (typeof text !== "string") {
    return undefined;
  }
  const model = value["model"];
  const stopReason = value["stopReason"];
  const base = {
    text,
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof stopReason === "string" ? { stopReason } : {}),
  };
  const toolCalls = value["toolCalls"];
  if (Array.isArray(toolCalls)) {
    const decoded = toolCalls.map(decodeToolCall);
    if (decoded.some((call) => call === undefined)) {
      return undefined;
    }
    return { ...base, toolCalls: decoded.filter(isDefined) };
  }
  if ("parsed" in value) {
    const parseError = decodeParseError(value["parseError"]);
    return {
      ...base,
      parsed: value["parsed"],
      ...(parseError ? { parseError } : {}),
    };
  }
  return base;
}

function decodeToolCall(value: Json): SamplingToolCall | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const id = value["id"];
  const name = value["name"];
  const args = value["arguments"];
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    args === null ||
    typeof args !== "object" ||
    Array.isArray(args)
  ) {
    return undefined;
  }
  return { id, name, arguments: args };
}

function decodeParseError(
  value: Json | undefined,
): { message: string; rawText: string } | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const message = value["message"];
  const rawText = value["rawText"];
  return typeof message === "string" && typeof rawText === "string"
    ? { message, rawText }
    : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function decodeElicitResponse(value: Json): WireElicitResult<unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const action = value["action"];
  if (action === "accept" && "content" in value) {
    return { action, content: value["content"] };
  }
  if (action === "decline" || action === "cancel") {
    const reason = value["reason"];
    return {
      action,
      ...(typeof reason === "string" ? { reason } : {}),
    };
  }
  return undefined;
}

function isForeignDurability(value: Json | undefined): value is ForeignDurability {
  return (
    value === "opaque" ||
    value === "ephemeral_handle" ||
    value === "resumable_handle" ||
    value === "server_task" ||
    value === "crank_native"
  );
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
