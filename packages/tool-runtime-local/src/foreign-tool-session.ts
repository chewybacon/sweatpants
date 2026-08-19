import { action, race, type Operation } from "effection";
import { z } from "zod";

import { isDurableToolSessionFacade } from "./durable-tool-session-facade.ts";
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
} from "@sweatpants/durable-effects";
import type {
  ForeignContinuation,
  ForeignDurability,
  ForeignInputRequest,
  ForeignToolContinueRequest,
  ForeignToolDisposition,
} from "@sweatpants/durable-execution";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  ToolInvocationHostError,
  ToolInvocationHostPort,
  type ToolInvocationAsk,
  type ToolInvocationHost,
  type ToolInvocationTurn,
} from "@sweatpants/tool-session";
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

export interface ToolInvocationForeignDriverOptions {
  tools: ReadonlyMap<string, AnyToolContract>;
}

export type ToolInvocationForeignEffectRegistrations = readonly [
  start: DurableEffectRegistration,
  continuation: DurableEffectRegistration,
];

/**
 * Creates durable foreign-tool effects over the pull-based invocation host.
 * The adapter owns durable continuation encoding. It resolves only the scoped
 * host Port; composition chooses the concrete local, worker, or remote host.
 * The host owns tool identity, response delivery, and the crank after each
 * response.
 */
export function createToolInvocationForeignEffectRegistrations(
  options: ToolInvocationForeignDriverOptions,
): ToolInvocationForeignEffectRegistrations {
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
      const host = yield* ToolInvocationHostPort.use();
      const invocationId = foreignSessionId(context.sessionId, context.taskId);
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
          "foreign_session_create_failed",
          "Foreign tool invocation could not start",
        );
      }
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
      let turn: ToolInvocationTurn;
      try {
        turn = yield* turnWithCancellation(host, turnRequest, context);
      } catch (error) {
        if (error instanceof ToolInvocationHostError && error.code === "invocation_not_found") {
          return failure(
            continuation.durability,
            "foreign_continuation_lost",
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
): Operation<ToolInvocationTurn> {
  return yield* race([
    host.turn(request),
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
        type: "cancelled",
        reason: "durable program cancelled",
      } satisfies ToolInvocationTurn;
    })(),
  ]);
}

function* decodeResume(
  request: ForeignToolContinueRequest,
  continuation: ToolSessionContinuationState,
): Operation<
  | {
      type: "valid";
      value: NonNullable<Parameters<ToolInvocationHost["turn"]>[0]["resume"]>;
    }
  | { type: "invalid"; failure: ForeignToolDisposition }
> {
  if (request.response.kind === "cancel") {
    return { type: "valid", value: { kind: "cancel", reason: "durable program cancelled" } };
  }
  if (request.response.kind !== continuation.pending.kind) {
    return {
      type: "invalid",
      failure: failure(
        continuation.durability,
        "foreign_response_kind_mismatch",
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
            "foreign_sample_response_invalid",
            "Foreign sample response is invalid",
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
          "foreign_elicit_response_invalid",
          "Foreign elicitation response is invalid",
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
  turn: ToolInvocationTurn,
  invocationId: string,
  durability: ForeignDurability,
): ForeignToolDisposition {
  switch (turn.type) {
    case "completed":
      return { type: "completed", result: turn.result };
    case "failed":
      return failure(durability, "foreign_tool_error", turn.error.message);
    case "cancelled":
      return failure(
        durability,
        "foreign_tool_cancelled",
        turn.reason ?? "Foreign tool was cancelled",
      );
    case "parked":
      return {
        type: "input_required",
        request: inputRequestFromAsk(turn.ask),
        continuation: createContinuation(invocationId, turn, durability),
      };
  }
}

function inputRequestFromAsk(ask: ToolInvocationAsk): ForeignInputRequest {
  if (ask.kind === "sample") {
    return {
      kind: "sample",
      payload: foreignJson({
        invocation: {
          context: {
            messages: ask.messages,
            ...(ask.systemPrompt === undefined ? {} : { systemPrompt: ask.systemPrompt }),
          },
          ...(ask.maxTokens === undefined && ask.toolChoice === undefined
            ? {}
            : {
                options: {
                  ...(ask.maxTokens === undefined ? {} : { maxTokens: ask.maxTokens }),
                  ...(ask.toolChoice === undefined ? {} : { toolChoice: ask.toolChoice }),
                },
              }),
        },
        tools: ask.tools === undefined ? { type: "none" } : { type: "embedded", tools: ask.tools },
        response:
          ask.schema === undefined ? { type: "message" } : { type: "json", schema: ask.schema },
        ...(ask.modelPreferences === undefined ? {} : { modelPreferences: ask.modelPreferences }),
      }),
    };
  }
  return {
    kind: "elicit",
    key: ask.key,
    message: ask.message,
    responseSchema: foreignJson(ask.schema),
    binding: ask.binding,
    ...(ask.context === undefined ? {} : { context: foreignJson(ask.context) }),
  };
}

function createContinuation(
  invocationId: string,
  turn: Extract<ToolInvocationTurn, { type: "parked" }>,
  durability: ForeignDurability,
): ForeignContinuation {
  return {
    driver: "tool-session",
    state: {
      scheme: CONTINUATION_SCHEME,
      sessionId: invocationId,
      afterLsn: turn.cursor,
      pending: { kind: turn.ask.kind, requestId: turn.ask.requestId },
      durability,
    },
  };
}

function decodeContinuation(value: ForeignContinuation): ToolSessionContinuationState | undefined {
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
  const response = result.data;
  const base = {
    text: response.text,
    ...(response.model === undefined ? {} : { model: response.model }),
    ...(response.stopReason === undefined ? {} : { stopReason: response.stopReason }),
  };
  if ("toolCalls" in response) {
    return { ...base, toolCalls: response.toolCalls };
  }
  if ("parsed" in response) {
    return {
      ...base,
      parsed: response.parsed,
      ...(response.parseError === undefined ? {} : { parseError: response.parseError }),
    };
  }
  return base;
}

function decodeElicitResponse(value: Json): ElicitExchangeCompletion<Json> | undefined {
  const parsed = parseElicitExchangeCompletion(value);
  return parsed.ok ? parsed.value : undefined;
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
