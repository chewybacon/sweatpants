import { advanceToolInvocation, type ToolInvocationBoundary } from "../invocation-executor.ts";
import { action, race, type Operation } from "effection";
import { z } from "zod";

import { isDurableToolSessionFacade } from "./durable-tool-facade-marker.ts";
import {
  parseElicitExchangeCompletion,
  type AnyToolContract,
  type ElicitExchangeCompletion,
  type SampleExchangeCompletion,
} from "@sweatpants/agent-sdk";
import {
  createDurableEffectRegistration,
  type DurableEffectContext,
  type DurableEffectRegistration,
  type OperationOutcome,
} from "@sweatpants/durable-effects";
import type {
  EphemeralContinuation,
  EphemeralDurability,
  EphemeralInputRequest,
  EphemeralToolContinueRequest,
  EphemeralToolDisposition,
} from "@sweatpants/durable-execution";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  ToolInvocationHostError,
  ToolInvocationHostPort,
  type ToolInvocationAsk,
  type ToolInvocationHost,
  type ToolInvocationResume,
} from "../index.ts";
import {
  EPHEMERAL_TOOL_CONTINUE_EFFECT,
  EPHEMERAL_TOOL_START_EFFECT,
  ephemeralToolInvocationId,
} from "../ephemeral.ts";

const CONTINUATION_SCHEME = "sweatpants/tool-session-v1";

const ephemeralDurabilitySchema = z.enum(["opaque", "ephemeral_handle", "crank_native"]);

const continuationStateSchema = z.strictObject({
  scheme: z.literal(CONTINUATION_SCHEME),
  sessionId: z.string().min(1),
  afterLsn: z.number().int(),
  pending: z.strictObject({
    kind: z.enum(["sample", "elicit"]),
    requestId: z.string().min(1),
  }),
  durability: ephemeralDurabilitySchema,
});

type ToolSessionContinuationState = z.infer<typeof continuationStateSchema>;

const samplingToolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  input: z.json(),
  thoughtSignature: z.string().nullable(),
});

const sampleBaseFields = {
  text: z.string(),
  model: z.string().optional(),
  stopReason: z.string().optional(),
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

export interface ToolInvocationEphemeralDriverOptions {
  tools: ReadonlyMap<string, AnyToolContract>;
}

export type ToolInvocationEphemeralEffectRegistrations = readonly [
  start: DurableEffectRegistration,
  continuation: DurableEffectRegistration,
];

/**
 * Creates durable ephemeral-tool effects over the pull-based invocation host.
 * The adapter owns durable continuation encoding. It resolves only the scoped
 * host Port; composition chooses the concrete local, worker, or remote host.
 * The host owns tool identity, response delivery, and the crank after each
 * response.
 */
export function createToolInvocationEphemeralEffectRegistrations(
  options: ToolInvocationEphemeralDriverOptions,
): ToolInvocationEphemeralEffectRegistrations {
  const start = createDurableEffectRegistration(
    EPHEMERAL_TOOL_START_EFFECT,
    { mode: "unsafe" },
    successfulEffect(function* (request, context) {
      if (request.driver !== "tool-session") {
        return failure(
          request.durability,
          "ephemeral_driver_mismatch",
          `ToolSession driver cannot handle ${request.driver}`,
        );
      }
      const tool = options.tools.get(request.tool);
      if (!tool) {
        return failure(
          request.durability,
          "ephemeral_tool_not_found",
          `Ephemeral tool not found: ${request.tool}`,
        );
      }
      const host = yield* ToolInvocationHostPort.use();
      const invocationId = ephemeralToolInvocationId(context.sessionId, context.taskId);
      const toolInput = isDurableToolSessionFacade(tool)
        ? { invocationId: context.taskId, input: request.input }
        : request.input;

      try {
        yield* host.start({
          invocationId,
          tool,
          input: assertJson(toolInput),
        });
        const turn = yield* turnWithCancellation(
          host,
          {
            invocationId,
            commandId: context.pullId,
            cursor: 0,
          },
          context,
        );
        return dispositionFromTurn(turn, invocationId, request.durability);
      } catch {
        return failure(
          request.durability,
          "ephemeral_session_create_failed",
          "Ephemeral tool invocation could not start",
        );
      }
    }),
  );

  const continueRegistration = createDurableEffectRegistration(
    EPHEMERAL_TOOL_CONTINUE_EFFECT,
    { mode: "unsafe" },
    successfulEffect(function* (request, context) {
      const continuation = decodeContinuation(request.continuation);
      if (!continuation) {
        return failure(
          "ephemeral_handle",
          "ephemeral_continuation_invalid",
          "ToolSession continuation is invalid",
        );
      }

      const host = yield* ToolInvocationHostPort.use();
      const invocationId = continuation.sessionId;
      const resume = yield* decodeResume(request, continuation);
      if (resume.type === "invalid") {
        yield* host.turn({
          invocationId,
          commandId: `${context.pullId}:cancel-invalid-response`,
          cursor: continuation.afterLsn,
          resume: { kind: "cancel", reason: "invalid continuation response" },
        });
        yield* host.dispose(invocationId);
        return resume.failure;
      }

      const turnRequest = {
        invocationId,
        commandId: context.pullId,
        cursor: continuation.afterLsn,
        resume: resume.value,
      };
      let turn: ToolInvocationBoundary;
      try {
        turn = yield* turnWithCancellation(host, turnRequest, context);
      } catch (error) {
        if (error instanceof ToolInvocationHostError && error.code === "invocation_not_found") {
          return failure(
            continuation.durability,
            "ephemeral_continuation_lost",
            `Tool invocation ${invocationId} is unavailable`,
          );
        }
        throw error;
      }
      const disposition = dispositionFromTurn(turn, invocationId, continuation.durability);
      if (disposition.type !== "input_required") {
        yield* host.dispose(invocationId);
      }
      return disposition;
    }),
  );

  return [start, continueRegistration];
}

function* turnWithCancellation(
  host: ToolInvocationHost,
  request: Parameters<ToolInvocationHost["turn"]>[0],
  context: DurableEffectContext,
): Operation<ToolInvocationBoundary> {
  return yield* race([
    advanceToolInvocation(host, request),
    (function* () {
      if (!context.cancellation.aborted) {
        yield* action<void>((resolve) => {
          const onAbort = () => resolve();
          context.cancellation.addEventListener("abort", onAbort, { once: true });
          return () => context.cancellation.removeEventListener("abort", onAbort);
        });
      }
      // This is an active-attempt abort, not semantic cancellation. Returning
      // from the race stops waiting for this crank. The durable authority later
      // replays and supplies `{ kind: "cancel" }` through a separate turn.
      // Do not start a second concurrent crank here.
      return {
        kind: "cancelled",
        reason: "durable program cancelled",
      } satisfies ToolInvocationBoundary;
    })(),
  ]);
}

function* decodeResume(
  request: EphemeralToolContinueRequest,
  continuation: ToolSessionContinuationState,
): Operation<
  | {
      type: "valid";
      value: NonNullable<Parameters<ToolInvocationHost["turn"]>[0]["resume"]>;
    }
  | { type: "invalid"; failure: EphemeralToolDisposition }
> {
  if (request.response.kind === "cancel") {
    return { type: "valid", value: { kind: "cancel", reason: "durable program cancelled" } };
  }
  if (request.response.kind !== continuation.pending.kind) {
    return {
      type: "invalid",
      failure: failure(
        continuation.durability,
        "ephemeral_response_kind_mismatch",
        `Expected ${continuation.pending.kind}, received ${request.response.kind}`,
      ),
    };
  }
  if (request.response.kind === "sample") {
    const response = decodeSampleResponse(request.response.value);
    return response
      ? {
          type: "valid",
          value: { kind: "sample", requestId: continuation.pending.requestId, response },
        }
      : {
          type: "invalid",
          failure: failure(
            continuation.durability,
            "ephemeral_sample_response_invalid",
            "Ephemeral sample response is invalid",
          ),
        };
  }
  const response = decodeElicitResponse(request.response.value);
  return response
    ? {
        type: "valid",
        value: { kind: "elicit", requestId: continuation.pending.requestId, response },
      }
    : {
        type: "invalid",
        failure: failure(
          continuation.durability,
          "ephemeral_elicit_response_invalid",
          "Ephemeral elicitation response is invalid",
        ),
      };
}

function successfulEffect<I extends Json, O extends Json>(
  handler: (input: I, context: DurableEffectContext) => Operation<O>,
): (input: I, context: DurableEffectContext) => Operation<{ status: "ok"; value: O }> {
  return function* (input, context) {
    return { status: "ok", value: yield* handler(input, context) };
  };
}

function dispositionFromTurn(
  turn: ToolInvocationBoundary,
  invocationId: string,
  durability: EphemeralDurability,
): EphemeralToolDisposition {
  switch (turn.kind) {
    case "completed":
      return { type: "completed", result: turn.value };
    case "failed":
      return failure(durability, "ephemeral_tool_error", turn.error.message);
    case "cancelled":
      return failure(
        durability,
        "ephemeral_tool_cancelled",
        turn.reason ?? "Ephemeral tool was cancelled",
      );
    case "suspended":
      return {
        type: "input_required",
        request: inputRequestFromAsk(turn.request),
        continuation: createContinuation(invocationId, turn, durability),
      };
  }
}

function inputRequestFromAsk(ask: ToolInvocationAsk): EphemeralInputRequest {
  if (ask.kind === "sample") {
    return {
      kind: "sample",
      payload: canonicalToolJson({
        invocation: {
          context: {
            messages: ask.messages,
            /* CONDITIONAL-SPREAD: Omit absent systemPrompt from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
            ...(ask.systemPrompt === undefined ? {} : { systemPrompt: ask.systemPrompt }),
          },
          /* CONDITIONAL-SPREAD: Omit absent options from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
          ...(ask.maxTokens === undefined && ask.toolChoice === undefined
            ? {}
            : {
                options: {
                  /* CONDITIONAL-SPREAD: Omit absent maxTokens from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
                  ...(ask.maxTokens === undefined ? {} : { maxTokens: ask.maxTokens }),
                  /* CONDITIONAL-SPREAD: Omit absent toolChoice from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
                  ...(ask.toolChoice === undefined ? {} : { toolChoice: ask.toolChoice }),
                },
              }),
        },
        tools: ask.tools === undefined ? { type: "none" } : { type: "embedded", tools: ask.tools },
        response:
          ask.schema === undefined ? { type: "message" } : { type: "json", schema: ask.schema },
        /* CONDITIONAL-SPREAD: Omit absent modelPreferences from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
        ...(ask.modelPreferences === undefined ? {} : { modelPreferences: ask.modelPreferences }),
      }),
    };
  }
  return {
    kind: "elicit",
    key: ask.key,
    message: ask.message,
    responseSchema: canonicalToolJson(ask.schema),
    binding: ask.binding,
    /* CONDITIONAL-SPREAD: Omit absent context from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
    ...(ask.context === undefined ? {} : { context: canonicalToolJson(ask.context) }),
  };
}

function createContinuation(
  invocationId: string,
  turn: Extract<ToolInvocationBoundary, { kind: "suspended" }>,
  durability: EphemeralDurability,
): EphemeralContinuation {
  return {
    driver: "tool-session",
    state: {
      scheme: CONTINUATION_SCHEME,
      sessionId: invocationId,
      afterLsn: turn.request.cursor,
      pending: { kind: turn.request.kind, requestId: turn.request.requestId },
      durability,
    },
  };
}

function decodeContinuation(
  value: EphemeralContinuation,
): ToolSessionContinuationState | undefined {
  if (value.driver !== "tool-session") {
    return undefined;
  }
  return continuationStateSchema.safeParse(value.state).data;
}

function decodeSampleResponse(value: Json): SampleExchangeCompletion | undefined {
  const result = sampleResponseSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  // Provider call/content metadata is not part of the tool's sample completion.
  const { calls: _calls, content: _content, ...completion } = result.data;
  return completion;
}

function decodeElicitResponse(value: Json): ElicitExchangeCompletion<Json> | undefined {
  const parsed = parseElicitExchangeCompletion(value);
  return parsed.ok ? parsed.value : undefined;
}

function failure(
  durability: EphemeralDurability,
  code: string,
  message: string,
): EphemeralToolDisposition {
  return {
    type: "failed",
    error: { code, message, durability, retryable: false },
  };
}

function canonicalToolJson(value: unknown): Json {
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

// ── Session-side executor for parked ephemeral pulls ──

/** Relays a live tool's backchannel asks to whoever can answer them. */
export interface EphemeralAskRelay {
  /** Answer a sampling ask with a sample exchange completion. */
  sample?(ask: {
    requestId: string;
    text?: string;
    systemPrompt?: string;
    messages?: readonly unknown[];
  }): Operation<{ text: string }>;
  /** Answer an elicitation ask with accept/decline/cancel. */
  elicit?(request: { message: string; context?: Json | undefined }): Operation<{
    action: "accept" | "decline" | "cancel";
    content?: Json;
    reason?: string;
  }>;
}

function* turnOnce(
  host: ToolInvocationHost,
  invocationId: string,
  cursor: number,
  commandId: string,
  resume: ToolInvocationResume | undefined,
): Operation<ToolInvocationBoundary> {
  const turnRequest: {
    invocationId: string;
    commandId: string;
    cursor: number;
    resume?: ToolInvocationResume;
  } = {
    invocationId,
    commandId,
    cursor,
  };
  if (resume !== undefined) {
    turnRequest.resume = resume;
  }
  return yield* turnWithCancellation(
    host,
    turnRequest,
    // The executor runs outside any attempt; cancellation is host-driven
    // process death, so a fresh non-aborted signal is correct here.
    {
      sessionId: "",
      taskId: "",
      pullId: commandId,
      attemptId: "none",
      cancellation: new AbortController().signal,
      resolver: { audience: "ephemeral:tool-session" },
    } as never,
  );
}

/**
 * Executes one session-bound ephemeral tool call against the invocation host
 * and returns the outcome to journal on the parked pull. The tool's own
 * sample/elicit asks ride {@link EphemeralAskRelay}; unanswered kinds fail the
 * call closed.
 */
export function* executeEphemeralToolCall(
  options: ToolInvocationEphemeralDriverOptions,
  request: {
    readonly driver: string;
    readonly tool: string;
    readonly input: Json;
    readonly durability: EphemeralDurability;
  },
  identity: { readonly sessionId: string; readonly taskId: string; readonly pullId: string },
  relay?: EphemeralAskRelay,
): Operation<OperationOutcome> {
  const fail = (code: string, message: string): OperationOutcome => ({
    status: "error",
    error: { code, message },
  });

  if (request.driver !== "tool-session") {
    return fail("ephemeral_driver_mismatch", `ToolSession driver cannot handle ${request.driver}`);
  }
  if (request.durability !== "ephemeral_handle") {
    return fail("unsupported_park", "Only ephemeral_handle calls are supported");
  }
  const tool = options.tools.get(request.tool);
  if (!tool) {
    return fail("ephemeral_tool_not_found", `Ephemeral tool not found: ${request.tool}`);
  }

  const host = yield* ToolInvocationHostPort.use();
  const invocationId = ephemeralToolInvocationId(
    identity.sessionId,
    `${identity.taskId}:${identity.pullId}`,
  );
  const toolInput = isDurableToolSessionFacade(tool)
    ? { invocationId: identity.taskId, input: request.input }
    : request.input;

  try {
    yield* host.start({
      invocationId,
      tool,
      input: assertJson(toolInput),
    });
  } catch {
    return fail("ephemeral_session_create_failed", "Ephemeral tool invocation could not start");
  }

  let cursor = 0;
  let commandIndex = 0;
  let event: ToolInvocationBoundary = yield* turnOnce(
    host,
    invocationId,
    cursor,
    `${identity.pullId}:0`,
    undefined,
  );

  for (;;) {
    cursor = event.kind === "suspended" ? event.request.cursor : cursor;

    if (event.kind === "completed") {
      return { status: "ok", value: assertJson(event.value) };
    }
    if (event.kind === "failed") {
      return {
        status: "error",
        error: { code: "ephemeral_tool_error", message: event.error.message },
      };
    }
    if (event.kind === "cancelled") {
      return { status: "cancelled" };
    }

    const ask = event.request as {
      kind: "sample" | "elicit";
      requestId: string;
      messages?: readonly { type?: string; text?: string }[];
      systemPrompt?: string;
      message?: string;
      context?: Json;
    };

    let answer: unknown;
    try {
      if (ask.kind === "sample") {
        if (!relay?.sample) {
          return fail("ephemeral_ask_unanswered", "No sample relay configured");
        }
        const lastText = ask.messages?.at(-1)?.text;
        answer = yield* relay.sample({
          /* CONDITIONAL-SPREAD: Omit absent text from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
          ...(lastText !== undefined ? { text: lastText } : {}),
          /* CONDITIONAL-SPREAD: Omit absent systemPrompt from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
          ...(ask.systemPrompt !== undefined ? { systemPrompt: ask.systemPrompt } : {}),
          requestId: ask.requestId,
        });
      } else {
        if (!relay?.elicit) {
          return fail("ephemeral_ask_unanswered", "No elicit relay configured");
        }
        answer = yield* relay.elicit({
          message: ask.message ?? "",
          /* CONDITIONAL-SPREAD: Omit absent context from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
          ...(ask.context !== undefined ? { context: ask.context as Json } : {}),
        });
      }
    } catch (error) {
      return fail(
        "ephemeral_ask_failed",
        error instanceof Error ? error.message : "Ephemeral ask could not be answered",
      );
    }

    commandIndex += 1;
    const resume: ToolInvocationResume =
      ask.kind === "elicit"
        ? {
            kind: "elicit",
            requestId: ask.requestId,
            response: answer as {
              action: "accept";
              content: Json;
            },
          }
        : {
            kind: "sample",
            requestId: ask.requestId,
            response: answer as {
              text: string;
            },
          };

    try {
      event = yield* turnOnce(
        host,
        invocationId,
        cursor,
        `${identity.pullId}:${commandIndex}`,
        resume,
      );
    } catch (error) {
      if (error instanceof ToolInvocationHostError && error.code === "invocation_not_found") {
        return fail("ephemeral_reference_lost", `Live reference ${invocationId} is gone`);
      }
      throw error;
    }
  }
}
