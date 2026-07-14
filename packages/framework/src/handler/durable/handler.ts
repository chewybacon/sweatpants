/**
 * Durable Chat Handler
 *
 * A pull-based chat handler that buffers all stream events for:
 * - Client reconnection from last LSN
 * - Multi-client fan-out
 * - Full session replay
 *
 * Protocol:
 * - Request params: sessionId/stream id (query/path), offset (query)
 * - Response: NDJSON with LSN in each event, X-Session-Id + X-Conversation-Id headers
 *
 * Identity law (kernel vs wire vs transport):
 * - conversationId: only durable chat key (crank journal / history / resume)
 * - threadId: AG-UI wire alias of conversationId (always equal on the wire)
 * - runId: ephemeral AG-UI turn correlator (never keys crank state)
 * - sessionId (X-Session-Id): response-stream / reconnect buffer id only
 *
 * @see ../docs/durable-chat-handler-plan.md for architecture details
 */
import { call, resource, type Operation, type Stream, type Subscription } from "effection";
import {
  useSessionRegistryStore,
  useSessionRegistry,
  useTokenBufferStore,
  type SessionHandle,
  type SessionRegistry,
  type TokenBufferStore,
} from "../../lib/chat/durable-streams/index.ts";
import { MaxIterationsContext, PersonaResolverContext } from "../../lib/chat/contexts.ts";
import {
  ModelProviderApi,
  ModelProviderContext,
  type ModelProviderDriver,
} from "../../lib/chat/model-provider.ts";
import {
  ToolExposureApi,
  ToolInventoryApi,
  type ToolDefinition,
} from "../../lib/chat/tool-inventory.ts";
import { ToolRuntimeContext } from "../../lib/chat/tool-runtime.ts";
import { useLogger } from "../../lib/logger/index.ts";
import { bindModel, createBindingSource, stringParam } from "../model-binder.ts";
import { createStreamingHandler, useHandlerContext } from "../streaming.ts";
import type { StreamEvent } from "../types.ts";
import { createProgramDriverChatEngine } from "./program-driver-chat-engine.ts";
import { useOptionalProgramDriverForeignEffects } from "./program-driver-effects.ts";
import { buildAgUiCustomState } from "../../lib/chat/session/ag-ui-checkpoint.ts";
import {
  activitySnapshotsForMessages,
  toProviderHistorySnapshot,
} from "../../lib/chat/session/ag-ui-projection.ts";
import { agUiMessagesToInternalMessages } from "../../lib/chat/session/ag-ui-compat.ts";
import {
  replayFramesToConversation,
  type DurableFrame,
} from "../../lib/chat/session/durable-history.ts";
import type { ElicitRequestStreamEvent } from "../../lib/chat/session/streaming.ts";
import {
  readLatestConversationCheckpoint,
  recordConversationCheckpoint,
  recordConversationSession,
  resolveLatestConversationSession,
} from "./conversation-index.ts";
import {
  createEmptyStream,
  createHeadMetadataResponse,
  createProtocolMutationResponse,
  createProtocolReadResponse,
  parseLiveMode,
  parseOffsetParam,
  parseSessionIdFromPath,
  parseTimeoutMs,
  toOffsetString,
} from "@sweatpants/durable-streams";
import type {
  ChatRequestBody,
  DurableChatHandlerConfig,
  ElicitResponse,
  ProgramRuntimeChatEngineParams,
  ToolSchema,
} from "./types.ts";
import type { Runtime } from "../../lib/chat/runtime/index.ts";
import {
  deriveResumeScopeFromEntries,
  deriveResumeScopeId,
  interruptRecordsForThread,
  openInterruptsForThread,
  registerInterruptsFromRunFinished,
  upsertInterruptRecords,
  validateResumeEntries,
  type OpenInterruptRecord,
} from "./interrupt-registry.ts";
import { resolvePrivateSystemPrompt } from "./model-context-registry.ts";
import { readLatestThreadInterruptState, recordThreadInterruptState } from "./interrupt-store.ts";
import { readLatestThreadSystemPrompt, recordThreadSystemPrompt } from "./model-context-store.ts";

// =============================================================================
// PROTOCOL PARAMETER BINDER
// =============================================================================

/**
 * Binder for durable stream protocol parameters.
 */
const durableParamsBinder = bindModel({
  sessionId: stringParam("x-unused-session-id", "sessionId"),
  conversationId: stringParam("x-conversation-id", "conversationId"),
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function definitionToToolSchema(definition: ToolDefinition): ToolSchema {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  };
}

/**
 * Create a serialized event stream from the chat engine.
 * Each event is JSON-serialized for storage in the buffer.
 */
const PUBLIC_SWEATPANTS_METADATA_KEYS = new Set(["sweatpants/toolName", "sweatpants/key"]);

function sanitizePublicMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!key.startsWith("sweatpants/") || PUBLIC_SWEATPANTS_METADATA_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function withPublicMetadata<T extends { metadata?: Record<string, unknown> }>(
  value: T,
): Omit<T, "metadata"> & { metadata?: Record<string, unknown> } {
  const { metadata: rawMetadata, ...rest } = value;
  const metadata = sanitizePublicMetadata(rawMetadata);
  return {
    ...rest,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function toStrictPublicEvent(event: StreamEvent): StreamEvent | null {
  switch ((event as { type: string }).type) {
    case "tool_session_error":
      return {
        type: "RUN_ERROR",
        message: (event as { message?: string }).message ?? "Tool session failed",
        code: "TOOL_RESUME_FAILED",
      };
    case "tool_session_status":
      return (event as { status?: string }).status === "aborted"
        ? { type: "RUN_ERROR", message: "Tool execution aborted", code: "RUN_ABORTED" }
        : null;
    case "session_info":
    case "elicit_request":
    case "conversation_state":
    case "ag_ui_checkpoint":
      return null;
    case "RUN_FINISHED": {
      const runFinished = event as Extract<StreamEvent, { type: "RUN_FINISHED" }>;
      if (runFinished.outcome?.type !== "interrupt") {
        return runFinished;
      }
      return {
        ...runFinished,
        outcome: {
          ...runFinished.outcome,
          interrupts: runFinished.outcome.interrupts.map((interrupt) =>
            withPublicMetadata(interrupt),
          ),
        },
      };
    }
    default:
      return event;
  }
}

/**
 * Create a serialized event stream from the chat engine.
 * Each event is JSON-serialized for storage in the buffer.
 */
function createSerializedEventStream(
  engine: Stream<StreamEvent, void>,
  initialEvents: StreamEvent[] = [],
  options?: {
    conversationId?: string;
    checkpointStore?: TokenBufferStore<string>;
  },
): Stream<string, void> {
  return resource(function* (provide) {
    const subscription = yield* engine;
    let initialIndex = 0;
    let emittedCount = 0;
    let checkpointPersisted = false;
    const emittedFrames: DurableFrame[] = [];

    function* persistCheckpointIfNeeded(): Operation<void> {
      if (checkpointPersisted || !options?.conversationId || !options.checkpointStore) {
        return;
      }
      checkpointPersisted = true;
      const checkpointEvents = yield* buildCheckpointSnapshotEventsFromFrames(emittedFrames);
      if (checkpointEvents.length === 0) {
        return;
      }
      yield* recordConversationCheckpoint(
        options.checkpointStore,
        options.conversationId,
        JSON.stringify(checkpointEvents),
      );
    }

    function* persistInterruptStateIfNeeded(rawEvent: StreamEvent): Operation<void> {
      if (
        rawEvent.type !== "RUN_FINISHED" ||
        !options?.conversationId ||
        !options.checkpointStore
      ) {
        return;
      }

      yield* recordThreadInterruptState(
        options.checkpointStore,
        options.conversationId,
        interruptRecordsForThread(options.conversationId),
      );
    }

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        while (initialIndex < initialEvents.length) {
          const rawEvent = initialEvents[initialIndex++]!;
          registerInterruptsFromRunFinished(rawEvent);
          yield* persistInterruptStateIfNeeded(rawEvent);
          const event = toStrictPublicEvent(rawEvent);
          if (!event) {
            continue;
          }
          emittedFrames.push({ lsn: ++emittedCount, event });
          return { done: false, value: JSON.stringify(event) };
        }

        while (true) {
          const result = yield* subscription.next();
          if (result.done) {
            yield* persistCheckpointIfNeeded();
            return { done: true, value: undefined };
          }
          registerInterruptsFromRunFinished(result.value);
          yield* persistInterruptStateIfNeeded(result.value);
          const event = toStrictPublicEvent(result.value);
          if (!event) {
            continue;
          }
          emittedFrames.push({ lsn: ++emittedCount, event });
          return { done: false, value: JSON.stringify(event) };
        }
      },
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forwardedClientReplayTraces(forwardedProps: unknown): Record<string, unknown> {
  if (!isRecord(forwardedProps)) {
    return {};
  }
  const sweatpants = forwardedProps["sweatpants"];
  if (!isRecord(sweatpants)) {
    return {};
  }
  const traces = sweatpants["clientReplayTraces"];
  return isRecord(traces) ? traces : {};
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function normalizeIncomingMessages(messages: unknown): ChatRequestBody["messages"] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const normalized: ChatRequestBody["messages"] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isRecord(message)) {
      continue;
    }

    const role = message["role"];
    const id =
      typeof message["id"] === "string" && message["id"].length > 0
        ? message["id"]
        : `${typeof role === "string" ? role : "message"}:${index}`;
    const content =
      typeof message["content"] === "string"
        ? message["content"]
        : message["content"] === undefined
          ? ""
          : JSON.stringify(message["content"]);

    if (role === "assistant") {
      const toolCalls = Array.isArray(message["tool_calls"])
        ? message["tool_calls"]
        : Array.isArray(message["toolCalls"])
          ? message["toolCalls"]
          : [];
      normalized.push({
        id,
        role: "assistant" as const,
        content,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.filter(isRecord).map((toolCall) => {
                const fn = isRecord(toolCall["function"]) ? toolCall["function"] : {};
                return {
                  id: typeof toolCall["id"] === "string" ? toolCall["id"] : `tool:${index}`,
                  type: "function" as const,
                  function: {
                    name: typeof fn["name"] === "string" ? fn["name"] : "unknown",
                    arguments: parseToolArguments(fn["arguments"]),
                  },
                };
              }),
            }
          : {}),
      });
      continue;
    }

    if (role === "tool") {
      const toolCallId =
        typeof message["tool_call_id"] === "string"
          ? message["tool_call_id"]
          : typeof message["toolCallId"] === "string"
            ? message["toolCallId"]
            : "";
      normalized.push({ id, role: "tool" as const, content, tool_call_id: toolCallId });
      continue;
    }

    if (role === "activity") {
      const activityType =
        typeof message["activityType"] === "string"
          ? message["activityType"]
          : "sweatpants:activity";
      normalized.push({ id, role: "activity" as const, activityType, content });
      continue;
    }

    if (role === "developer") {
      normalized.push({ id, role: "developer" as const, content });
    } else if (role === "system") {
      normalized.push({ id, role: "system" as const, content });
    } else if (role === "reasoning") {
      normalized.push({ id, role: "reasoning" as const, content });
    } else if (role === "user") {
      normalized.push({ id, role: "user" as const, content });
    }
  }

  return normalized;
}

function normalizeChatRequestBody(body: ChatRequestBody): ChatRequestBody {
  return {
    ...body,
    messages: normalizeIncomingMessages(body.messages),
  };
}

function mapResumeEntriesToElicitResponses(
  body: ChatRequestBody,
  records: OpenInterruptRecord[],
  runtimeId: string,
): ElicitResponse[] {
  const resume = body.resume ?? [];
  if (resume.length === 0) {
    return [];
  }

  const traces = forwardedClientReplayTraces(body.forwardedProps);
  const recordsByInterruptId = new Map(records.map((record) => [record.interruptId, record]));
  const mapped: ElicitResponse[] = [];

  for (const entry of resume) {
    const record = recordsByInterruptId.get(entry.interruptId);
    if (!record?.toolCallId) {
      continue;
    }
    const result =
      entry.status === "cancelled"
        ? { action: "cancel" as const }
        : mapResolvedResumePayload(entry.payload);
    const sessionId = record.sessionId ?? record.executionId ?? record.toolCallId;
    const response: ElicitResponse = {
      sessionId,
      callId: record.toolCallId,
      ...(record.toolName ? { toolName: record.toolName } : {}),
      elicitId: entry.interruptId,
      result,
      ref: {
        runtimeId: record.runtimeId ?? runtimeId,
        executionId: record.executionId ?? sessionId,
        sessionId,
        callId: record.toolCallId,
        toolName: record.toolName ?? "",
      },
    };
    const trace = traces[entry.interruptId];
    if (trace !== undefined) {
      response.trace = trace as NonNullable<ElicitResponse["trace"]>;
    }
    mapped.push(response);
  }

  return mapped;
}

function mapResolvedResumePayload(payload: unknown): ElicitResponse["result"] {
  if (isRecord(payload) && payload["action"] === "accept") {
    return { action: "accept", content: payload["content"] };
  }
  if (isRecord(payload) && payload["action"] === "decline") {
    return { action: "decline" };
  }
  return { action: "accept", content: payload };
}

function createRuntimeFromModelProviderDriver(driver: ModelProviderDriver): Runtime {
  return {
    stream(model, context, options) {
      return resource(function* (provide) {
        const stream = driver.stream({
          model,
          context,
          ...(options ? { options } : {}),
        });
        const subscription = yield* stream;
        yield* provide(subscription);
      });
    },
    *generateImages() {
      throw new Error("ModelProviderApi runtime adapter does not support image generation");
    },
  };
}

function recordToElicit(record: OpenInterruptRecord): ElicitRequestStreamEvent | null {
  if (!record.toolCallId) {
    return null;
  }
  return {
    type: "elicit_request",
    sessionId: record.toolCallId,
    callId: record.toolCallId,
    toolName: record.toolName ?? "unknown",
    elicitId: record.interruptId,
    key:
      typeof record.publicMetadata?.["sweatpants/key"] === "string"
        ? String(record.publicMetadata["sweatpants/key"])
        : record.interruptId,
    message: record.message ?? "Input required",
    schema: record.responseSchema && isRecord(record.responseSchema) ? record.responseSchema : {},
  };
}

function publicInterruptsFromRecords(records: OpenInterruptRecord[]) {
  return records.map((record) => {
    const metadata = sanitizePublicMetadata(record.publicMetadata);
    return {
      id: record.interruptId,
      reason: record.reason,
      ...(record.message ? { message: record.message } : {}),
      ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
      ...(record.responseSchema && isRecord(record.responseSchema)
        ? { responseSchema: record.responseSchema }
        : {}),
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  });
}

/**
 * REQ-042: the RUN_FINISHED interrupt marker is the authoritative pending resume
 * source; STATE_SNAPSHOT.pendingClientActions is a derived compatibility view.
 * Both derive from the same open interrupt records, so any divergence is an
 * implementation error. This guard rejects contradictory pending state before
 * it can be emitted to clients.
 */
export function assertPendingResumeConsistency(
  elicits: ElicitRequestStreamEvent[],
  openInterrupts: Pick<OpenInterruptRecord, "interruptId" | "toolCallId">[],
): void {
  const interruptIds = new Set(openInterrupts.map((record) => record.interruptId));
  for (const elicit of elicits) {
    if (!interruptIds.has(elicit.elicitId)) {
      throw new Error(
        `Pending resume state mismatch: derived pendingClientActions references interrupt "${elicit.elicitId}" that is not in the authoritative open interrupt set`,
      );
    }
  }
  const representable = openInterrupts.filter((record) => record.toolCallId);
  if (elicits.length !== representable.length) {
    throw new Error(
      `Pending resume state mismatch: ${representable.length} open interrupt(s) with toolCallId but ${elicits.length} derived pendingClientActions`,
    );
  }
}

function createSyntheticFrameStream(frames: DurableFrame[]): Stream<string, void> {
  return resource(function* (provide) {
    let emitted = false;
    const chunk = frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (emitted) {
          return { done: true, value: undefined };
        }
        emitted = true;
        return { done: false, value: chunk };
      },
    });
  });
}

function parseBufferedFrames(tokens: string[]): DurableFrame[] {
  const frames: DurableFrame[] = [];
  for (let index = 0; index < tokens.length; index++) {
    try {
      frames.push({ lsn: index + 1, event: JSON.parse(tokens[index]!) as StreamEvent });
    } catch {
      // Ignore malformed buffered tokens during hydrate synthesis.
    }
  }
  return frames;
}

function initialSnapshotBoundary(frames: DurableFrame[]): {
  messages: Extract<StreamEvent, { type: "MESSAGES_SNAPSHOT" }> | null;
  activities: Array<Extract<StreamEvent, { type: "ACTIVITY_SNAPSHOT" }>>;
  state: Extract<StreamEvent, { type: "STATE_SNAPSHOT" }> | null;
  nextIndex: number;
} {
  let index = 0;
  if (frames[index]?.event.type === "RUN_STARTED") {
    index += 1;
  }

  const messages =
    frames[index]?.event.type === "MESSAGES_SNAPSHOT"
      ? (frames[index++]!.event as Extract<StreamEvent, { type: "MESSAGES_SNAPSHOT" }>)
      : null;

  const activities: Array<Extract<StreamEvent, { type: "ACTIVITY_SNAPSHOT" }>> = [];
  while (frames[index]?.event.type === "ACTIVITY_SNAPSHOT") {
    activities.push(frames[index++]!.event as Extract<StreamEvent, { type: "ACTIVITY_SNAPSHOT" }>);
  }

  const state =
    frames[index]?.event.type === "STATE_SNAPSHOT"
      ? (frames[index++]!.event as Extract<StreamEvent, { type: "STATE_SNAPSHOT" }>)
      : null;

  return { messages, activities, state, nextIndex: index };
}

function sanitizeBoundarySnapshot(boundary: ReturnType<typeof initialSnapshotBoundary>) {
  const internalMessages = boundary.messages
    ? agUiMessagesToInternalMessages(boundary.messages.messages)
    : [];
  const messages = boundary.messages
    ? {
        type: "MESSAGES_SNAPSHOT" as const,
        messages: toProviderHistorySnapshot(internalMessages, undefined),
      }
    : null;
  const extractedActivities = activitySnapshotsForMessages(internalMessages, undefined);
  const activitiesByMessageId = new Map<
    string,
    Extract<StreamEvent, { type: "ACTIVITY_SNAPSHOT" }>
  >();
  for (const activity of [...extractedActivities, ...boundary.activities]) {
    activitiesByMessageId.set(activity.messageId, activity);
  }
  return {
    messages,
    activities: [...activitiesByMessageId.values()],
    state: boundary.state,
    nextIndex: boundary.nextIndex,
  };
}

function* buildCheckpointSnapshotEventsFromFrames(
  frames: DurableFrame[],
): Operation<StreamEvent[]> {
  const replay = yield* replayFramesToConversation(frames);
  return [
    {
      type: "MESSAGES_SNAPSHOT",
      messages: toProviderHistorySnapshot(replay.history, replay.replayState),
    },
    ...activitySnapshotsForMessages(replay.history, replay.replayState),
  ];
}

function storedCheckpointHydrateEvents(
  checkpointEvents: StreamEvent[],
  conversationId: string,
): StreamEvent[] {
  const openInterrupts = openInterruptsForThread(conversationId);
  const elicits = openInterrupts
    .map(recordToElicit)
    .filter((value): value is ElicitRequestStreamEvent => value !== null);
  assertPendingResumeConsistency(elicits, openInterrupts);

  return [
    ...checkpointEvents,
    {
      type: "STATE_SNAPSHOT",
      snapshot: buildAgUiCustomState({ elicits }),
    },
    ...(openInterrupts.length > 0
      ? [
          {
            type: "RUN_FINISHED" as const,
            threadId: conversationId,
            runId: openInterrupts[0]?.interruptedRunId ?? conversationId,
            outcome: {
              type: "interrupt" as const,
              interrupts: publicInterruptsFromRecords(openInterrupts),
            },
          },
        ]
      : []),
  ];
}

function* createStoredConversationCheckpointResponse(params: {
  ctx: { request: Request; headers: Headers; status?: number };
  conversationId: string;
  checkpointEvents: StreamEvent[];
  parsedOffset: ReturnType<typeof parseOffsetParam>;
}): Operation<{
  subscription: Subscription<string, void>;
  cleanup?: () => Operation<void>;
}> {
  const { ctx, conversationId, checkpointEvents, parsedOffset } = params;
  const offsetRequested = new URL(ctx.request.url).searchParams.has("offset");
  const resetRequested = offsetRequested && !parsedOffset.isNow && parsedOffset.value !== 0;
  const emptyRequested = offsetRequested && (parsedOffset.isNow || parsedOffset.value === 0);

  ctx.headers.set("Stream-Next-Offset", toOffsetString(0));
  ctx.headers.set("Stream-Up-To-Date", "true");
  if (resetRequested) {
    ctx.headers.set("Stream-Cursor-Reset", "true");
  }

  if (ctx.request.method.toUpperCase() === "HEAD" || emptyRequested) {
    const subscription = yield* createEmptyStream();
    return { subscription };
  }

  const subscription = yield* createSyntheticFrameStream(
    storedCheckpointHydrateEvents(checkpointEvents, conversationId).map((event, index) => ({
      lsn: index + 1,
      event,
    })),
  );

  return { subscription };
}

function* restoreThreadInterruptStateIfNeeded(
  bufferStore: TokenBufferStore<string>,
  threadId: string | undefined,
): Operation<void> {
  if (!threadId) {
    return;
  }
  const stored = yield* readLatestThreadInterruptState(bufferStore, threadId);
  if (!stored || stored.length === 0) {
    return;
  }
  upsertInterruptRecords(stored);
}

function* createConversationHydrateResponse(params: {
  ctx: { request: Request; headers: Headers };
  registry: SessionRegistry<string>;
  session: SessionHandle<string>;
  sessionId: string;
  conversationId: string;
  parsedOffset: ReturnType<typeof parseOffsetParam>;
}): Operation<{
  subscription: Subscription<string, void>;
  cleanup?: () => Operation<void>;
}> {
  const { ctx, registry, session, sessionId, conversationId, parsedOffset } = params;
  const { tokens, lsn } = yield* session.buffer.read(0);
  const frames = parseBufferedFrames(tokens);
  const complete = yield* session.buffer.isComplete();
  const openInterrupts = openInterruptsForThread(conversationId);
  const elicits = openInterrupts
    .map(recordToElicit)
    .filter((value): value is ElicitRequestStreamEvent => value !== null);
  assertPendingResumeConsistency(elicits, openInterrupts);
  const offsetRequested = new URL(ctx.request.url).searchParams.has("offset");
  let resetRequested = false;

  ctx.headers.set("Stream-Next-Offset", toOffsetString(lsn));

  let syntheticEvents: StreamEvent[] = [];

  if (complete) {
    resetRequested = offsetRequested && !parsedOffset.isNow;
    const replay = yield* replayFramesToConversation(frames);
    syntheticEvents = [
      {
        type: "MESSAGES_SNAPSHOT",
        messages: toProviderHistorySnapshot(replay.history, replay.replayState),
      },
      ...activitySnapshotsForMessages(replay.history, replay.replayState),
      {
        type: "STATE_SNAPSHOT",
        snapshot: buildAgUiCustomState({ elicits }),
      },
      ...(openInterrupts.length > 0
        ? [
            {
              type: "RUN_FINISHED" as const,
              threadId: conversationId,
              runId: openInterrupts[0]?.interruptedRunId ?? sessionId,
              outcome: {
                type: "interrupt" as const,
                interrupts: publicInterruptsFromRecords(openInterrupts),
              },
            },
          ]
        : []),
    ];
  } else {
    const boundary = sanitizeBoundarySnapshot(initialSnapshotBoundary(frames));
    let tailStartIndex = boundary.nextIndex;

    if (parsedOffset.isNow) {
      tailStartIndex = lsn;
    } else if (offsetRequested) {
      if (
        parsedOffset.value !== null &&
        parsedOffset.value >= boundary.nextIndex &&
        parsedOffset.value <= lsn
      ) {
        tailStartIndex = parsedOffset.value;
      } else {
        resetRequested = true;
      }
    }

    syntheticEvents = [
      ...(boundary.messages ? [boundary.messages] : []),
      ...boundary.activities,
      ...(boundary.state
        ? [boundary.state]
        : [
            {
              type: "STATE_SNAPSHOT" as const,
              snapshot: buildAgUiCustomState({ elicits }),
            },
          ]),
      ...frames.slice(tailStartIndex).map((frame) => frame.event),
    ];
  }

  if (resetRequested) {
    ctx.headers.set("Stream-Cursor-Reset", "true");
  }

  const syntheticFrames = syntheticEvents.map((event, index) => ({ lsn: index + 1, event }));

  const subscription = yield* createSyntheticFrameStream(syntheticFrames);
  return {
    subscription,
    cleanup: function* () {
      yield* registry.release(sessionId);
    },
  };
}

// =============================================================================
// DURABLE CHAT HANDLER
// =============================================================================

/**
 * Create a durable chat handler.
 *
 * The handler:
 * 1. Binds protocol params from request (sessionId, offset)
 * 2. Runs request setup to set up DI contexts
 * 3. Either reconnects to existing session or creates new one
 * 4. Streams events from buffer to response with LSN
 *
 * @param config - Handler configuration
 * @returns Fetch handler function
 */
function createEmptyChatEngine(): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        return { done: true, value: undefined };
      },
    });
  });
}

export function createDurableChatHandler(config: DurableChatHandlerConfig) {
  const { setup, maxToolIterations = 10 } = config;

  return createStreamingHandler(
    function* () {
      const ctx = yield* useHandlerContext();
      const request = ctx.request;
      const bindingSource = createBindingSource(request);
      const pathSessionId = parseSessionIdFromPath(new URL(request.url).pathname);
      const { sessionId: requestedSessionId, conversationId: requestedConversationIdParam } =
        durableParamsBinder(bindingSource);
      const parsedOffset = parseOffsetParam(bindingSource.searchParams.get("offset"));
      const liveMode = parseLiveMode(bindingSource.searchParams.get("live"));
      const timeoutMs = parseTimeoutMs(bindingSource.searchParams.get("timeout"));
      const method = request.method.toUpperCase();
      const isProtocolMutation =
        pathSessionId !== undefined &&
        (method === "PUT" || method === "POST" || method === "DELETE");

      // Parse request body for mutating requests only.
      const body =
        request.method === "POST" && !isProtocolMutation
          ? normalizeChatRequestBody((yield* call(() => request.json())) as ChatRequestBody)
          : ({ messages: [] } as ChatRequestBody);

      // Durable conversation identity resolution:
      //   1. explicit conversationId (body)
      //   2. conversationId query/header
      //   3. AG-UI threadId as alias
      //   4. server-minted id (returned via X-Conversation-Id)
      // Divergent body.threadId never forks identity once conversationId is set.
      const clientConversationId =
        body.conversationId?.trim() ||
        requestedConversationIdParam?.trim() ||
        body.threadId?.trim() ||
        undefined;
      const requestedConversationId = clientConversationId ?? crypto.randomUUID();

      // Run request-scoped setup before resolving durable dependencies.
      if (setup) {
        yield* setup({ request, body });
      }

      const bufferStore = yield* useTokenBufferStore<string>();
      yield* restoreThreadInterruptStateIfNeeded(bufferStore, requestedConversationId);
      const shouldResolveConversation =
        requestedConversationId !== undefined &&
        pathSessionId === undefined &&
        requestedSessionId === undefined &&
        method !== "POST";
      const resolvedConversationSessionId = shouldResolveConversation
        ? yield* resolveLatestConversationSession(bufferStore, requestedConversationId)
        : null;
      const storedConversationCheckpoint = shouldResolveConversation
        ? yield* readLatestConversationCheckpoint(bufferStore, requestedConversationId)
        : null;

      if (
        shouldResolveConversation &&
        !resolvedConversationSessionId &&
        !storedConversationCheckpoint
      ) {
        ctx.status = 404;
        return yield* createEmptyStream();
      }

      // Response-stream id (transport reconnect buffer). Not durable chat state.
      // Prefer path/query stream ids, then conversation→stream index, else mint.
      const sessionId =
        pathSessionId ??
        requestedSessionId ??
        resolvedConversationSessionId ??
        (storedConversationCheckpoint ? requestedConversationId! : crypto.randomUUID());
      const isReconnect =
        (pathSessionId !== undefined ||
          requestedSessionId !== undefined ||
          requestedConversationId !== undefined) &&
        (parsedOffset.value !== null || parsedOffset.isNow);
      const startLSN = parsedOffset.value ?? 0;

      // Set response headers
      // X-Session-Id = response stream / reconnect buffer id (transport)
      // X-Conversation-Id = durable conversation key (kernel)
      ctx.headers.set("X-Session-Id", sessionId);
      ctx.headers.set("X-Conversation-Id", requestedConversationId);
      ctx.headers.set("Cache-Control", "no-store");

      // Get logger after hooks run (so setupLogger has executed)
      const log = yield* useLogger("handler:durable");
      log.debug(
        {
          sessionId,
          conversationId: requestedConversationId,
          resolvedConversationSessionId,
          method,
          isReconnect,
          startLSN,
          messageCount: body.messages.length,
        },
        "request received",
      );

      if (isProtocolMutation) {
        const registryStore = yield* useSessionRegistryStore();

        return yield* createProtocolMutationResponse({
          ctx,
          sessionId,
          method: method as "PUT" | "POST" | "DELETE",
          bufferStore,
          registryStore,
          log,
        });
      }

      if (
        shouldResolveConversation &&
        !resolvedConversationSessionId &&
        storedConversationCheckpoint
      ) {
        const checkpointEvents = JSON.parse(storedConversationCheckpoint) as StreamEvent[];
        return yield* createStoredConversationCheckpointResponse({
          ctx,
          conversationId: requestedConversationId!,
          checkpointEvents,
          parsedOffset,
        });
      }

      // Get dependencies from contexts
      const modelProviderDriver = yield* ModelProviderContext.get();
      if (!modelProviderDriver) {
        throw new Error("Model provider not configured. Install a ModelProviderDriver in scope.");
      }
      const runtime = createRuntimeFromModelProviderDriver(modelProviderDriver);
      const model = yield* ModelProviderApi.model();
      const contextStreamOptions = yield* ModelProviderApi.streamOptions();
      const streamOptions =
        contextStreamOptions || body.streamOptions
          ? { ...contextStreamOptions, ...body.streamOptions }
          : undefined;
      // conversationId is the only durable chat key. threadId is always its
      // AG-UI alias. runId is request-scoped and must never fall back to the
      // response-stream id (sessionId).
      const durableConversationId = requestedConversationId;
      const agUiThreadId = durableConversationId;
      yield* restoreThreadInterruptStateIfNeeded(bufferStore, agUiThreadId);
      const agUiRunId = body.runId?.trim() || crypto.randomUUID();
      const requestedResumeScopeId = deriveResumeScopeId(agUiThreadId, body.parentRunId);
      const resumeScopeFromEntries = deriveResumeScopeFromEntries(body.resume);
      const openInterrupts = openInterruptsForThread(agUiThreadId);
      const hasOpenInterrupts = openInterrupts.length > 0;
      const supersedeOpenProgramTurn =
        method === "POST" &&
        hasOpenInterrupts &&
        body.resume === undefined &&
        body.elicitResponses === undefined &&
        body.pluginAbort === undefined &&
        body.messages.some((message) => message.role === "user");
      const effectivePluginAbort =
        body.pluginAbort ??
        (supersedeOpenProgramTurn
          ? {
              sessionId:
                openInterrupts[0]?.toolCallId ?? openInterrupts[0]?.interruptId ?? agUiRunId,
              reason: "superseded_by_user_message",
            }
          : undefined);
      const resumeValidation = effectivePluginAbort
        ? null
        : body.resume
          ? requestedResumeScopeId || resumeScopeFromEntries
            ? validateResumeEntries({
                threadId: resumeScopeFromEntries?.threadId ?? agUiThreadId,
                scopeId: requestedResumeScopeId ?? resumeScopeFromEntries!.scopeId,
                runId: agUiRunId,
                resume: body.resume,
              })
            : ({
                ok: false,
                code: "INVALID_RESUME",
                message: "Unable to determine resume scope",
              } as const)
          : hasOpenInterrupts && requestedResumeScopeId
            ? validateResumeEntries({
                threadId: agUiThreadId,
                scopeId: requestedResumeScopeId,
                runId: agUiRunId,
                resume: [],
              })
            : null;
      // Resume validation is pure. Interrupt state is committed only after the
      // crank respond commands are durably accepted by the adapter.
      const directElicitResponses = body.elicitResponses ?? [];
      log.debug(
        { provider: model.provider, model: model.id, api: model.api },
        "model provider configured",
      );

      const inventoryEntries = yield* ToolInventoryApi.list();
      const inventoryNames = new Set(inventoryEntries.map((entry) => entry.definition.name));
      const inventoryNameList = inventoryEntries.map((entry) => entry.definition.name);
      log.debug({ toolCount: inventoryEntries.length }, "tool inventory configured");

      const resolvePersona = yield* PersonaResolverContext.get();
      const maxIterations = (yield* MaxIterationsContext.get()) ?? maxToolIterations;

      // Get session registry from durable streams context
      log.debug("getting session registry");
      const registry: SessionRegistry<string> = yield* useSessionRegistry<string>();
      log.debug("session registry acquired");

      const activeToolRuntime = yield* ToolRuntimeContext.get();
      if (!activeToolRuntime) {
        throw new Error("Tool runtime not configured. Install a ToolRuntime in scope.");
      }

      const publicResumeResponses = resumeValidation?.ok
        ? mapResumeEntriesToElicitResponses(body, resumeValidation.records, activeToolRuntime.id)
        : [];
      const effectiveElicitResponses =
        directElicitResponses.length > 0 ? directElicitResponses : publicResumeResponses;
      const initialToolChoice = effectiveElicitResponses.length
        ? undefined
        : body.initialToolChoice;

      // Build tool schemas
      const enabledToolNames = new Set<string>();
      let systemPrompt: string | undefined;

      // Handle persona mode vs manual mode
      if (body.persona) {
        if (!resolvePersona) {
          throw new Error("Persona mode not supported - no resolver configured");
        }

        const resolved = resolvePersona(
          body.persona,
          body.personaConfig,
          body.enableOptionalTools,
          body.effort,
        );

        systemPrompt = resolved.systemPrompt;

        for (const toolName of resolved.tools) {
          if (inventoryNames.has(toolName)) {
            enabledToolNames.add(toolName);
          } else {
            throw new Error(`Unknown persona tool: ${toolName}`);
          }
        }
      } else {
        // Manual mode
        if (body.enabledTools === true) {
          for (const name of inventoryNameList) {
            enabledToolNames.add(name);
          }
        } else if (Array.isArray(body.enabledTools)) {
          for (const name of body.enabledTools) {
            if (inventoryNames.has(name)) {
              enabledToolNames.add(name);
            }
          }
        }

        if (body.systemPrompt) {
          systemPrompt = body.systemPrompt;
        }
      }

      const storedSystemPrompt = yield* readLatestThreadSystemPrompt(bufferStore, agUiThreadId);
      systemPrompt = resolvePrivateSystemPrompt(agUiThreadId, storedSystemPrompt ?? systemPrompt);
      if (systemPrompt && storedSystemPrompt == null) {
        yield* recordThreadSystemPrompt(bufferStore, agUiThreadId, systemPrompt);
      }

      // Build model-facing tool schemas through inventory + exposure policy.
      // `enabledPlugins` names match inventory `definition.name` directly because
      // both use the same final tool name from the single generated registry.
      const exposedDefinitions = yield* ToolExposureApi.definitions({
        phase: "outer-chat",
        entries: inventoryEntries,
        request: body,
        enabledTools: body.enabledTools === true ? true : Array.from(enabledToolNames),
        enabledPlugins: body.enabledPlugins ?? [],
        metadata: { sessionId, conversationId: requestedConversationId },
      });

      const seenNames = new Set<string>();
      const toolSchemas: ToolSchema[] = [];
      for (const schema of exposedDefinitions.map(definitionToToolSchema)) {
        if (!seenNames.has(schema.name)) {
          seenNames.add(schema.name);
          toolSchemas.push(schema);
        }
      }

      let session: SessionHandle<string>;

      // Debug: log which path we're taking and if we have elicit responses
      log.debug(
        {
          sessionId,
          isReconnect,
          hasElicitResponses: effectiveElicitResponses.length > 0,
          elicitResponseCount: effectiveElicitResponses.length,
        },
        "determining path",
      );

      if (method === "HEAD") {
        log.debug({ sessionId }, "head request");
        return yield* createHeadMetadataResponse(ctx, registry, sessionId, startLSN);
      }

      if (isReconnect) {
        // RECONNECT PATH: Acquire existing session, stream from buffer at offset
        log.debug({ sessionId, startLSN }, "reconnect path: acquiring existing session");
        session = yield* registry.acquire(sessionId);
        log.debug({ sessionId }, "reconnect path: session acquired");
      } else {
        // NEW SESSION PATH: Create engine, stream to buffer, then to response
        log.debug({ sessionId }, "new session path: creating chat engine");

        const agUiRun = {
          threadId: agUiThreadId,
          runId: agUiRunId,
          ...(body.parentRunId ? { parentRunId: body.parentRunId } : {}),
        };
        const programDriverForeignEffects = yield* useOptionalProgramDriverForeignEffects();

        const resumePreflightError =
          resumeValidation && !resumeValidation.ok ? resumeValidation : null;

        // Create the chat engine. If public resume validation failed, use an
        // empty engine and expose the failure as a schema-valid RUN_ERROR before
        // any replay projection or runtime continuation can occur.
        const engineParams: ProgramRuntimeChatEngineParams = {
          messages: body.messages,
          ...(systemPrompt !== undefined && { systemPrompt }),
          toolSchemas,
          runtime,
          model,
          ...(streamOptions ? { streamOptions } : {}),
          ...(initialToolChoice ? { initialToolChoice } : {}),
          toolInventoryEntries: inventoryEntries,
          toolRuntime: activeToolRuntime,
          maxIterations,
          conversationId: requestedConversationId,
          agUiRun,
          ...(effectiveElicitResponses.length > 0 && {
            elicitResponses: effectiveElicitResponses,
          }),
          ...(resumeValidation?.ok && !resumeValidation.idempotent
            ? {
                onResumeAccepted: function* (): Operation<void> {
                  upsertInterruptRecords(resumeValidation.records);
                  yield* recordThreadInterruptState(
                    bufferStore,
                    agUiThreadId,
                    interruptRecordsForThread(agUiThreadId),
                  );
                },
              }
            : {}),
          ...(effectivePluginAbort && { pluginAbort: effectivePluginAbort }),
        };
        const engine = resumePreflightError
          ? createEmptyChatEngine()
          : createProgramDriverChatEngine({
              ...engineParams,
              journalStore: config.programDriverJournalStore,
              ...(programDriverForeignEffects
                ? { foreignEffects: programDriverForeignEffects }
                : {}),
              ...(supersedeOpenProgramTurn ? { continueAfterCancellation: true } : {}),
            });
        log.debug({ sessionId }, "new session path: chat engine created");

        // Wrap engine to serialize events
        const initialReplayState = liveMode === "sse" ? undefined : body.replayState;
        const initialEvents: StreamEvent[] = resumePreflightError
          ? [
              {
                type: "RUN_ERROR",
                message: resumePreflightError.message,
                code: resumePreflightError.code,
              },
            ]
          : [
              {
                type: "RUN_STARTED",
                ...agUiRun,
                input: {
                  ...agUiRun,
                  state: body.state ?? {},
                  messages: toProviderHistorySnapshot(body.messages, initialReplayState),
                  tools: toolSchemas.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  })),
                  context: body.context ?? [],
                  forwardedProps: body.forwardedProps ?? {},
                  ...(body.resume ? { resume: body.resume } : {}),
                },
              },
              ...(body.messages.length > 0
                ? [
                    {
                      type: "MESSAGES_SNAPSHOT" as const,
                      messages: toProviderHistorySnapshot(body.messages, initialReplayState),
                    },
                    ...activitySnapshotsForMessages(body.messages, initialReplayState),
                  ]
                : []),
              {
                type: "STATE_SNAPSHOT",
                snapshot: buildAgUiCustomState({}),
              },
            ];
        const serializedStream = createSerializedEventStream(engine, initialEvents, {
          ...(clientConversationId ? { conversationId: durableConversationId } : {}),
          checkpointStore: bufferStore,
        });
        log.debug({ sessionId }, "new session path: serialized stream created");

        // Acquire session with the engine as source
        // The registry manages the writer task lifecycle internally via useBackgroundTask
        log.debug({ sessionId }, "new session path: acquiring session with source");
        session = yield* registry.acquire(sessionId, {
          source: serializedStream,
        });
        log.debug({ sessionId }, "new session path: session acquired");
      }

      // Only record the conversation session index when the client explicitly
      // provided a conversationId. When the server minted one (client didn't
      // send one), the index is recorded on the next request when the client
      // sends the minted id back (received from the X-Conversation-Id header).
      if (clientConversationId && method === "POST") {
        yield* recordConversationSession(bufferStore, durableConversationId, sessionId);
      }

      if (shouldResolveConversation && method === "GET" && liveMode === undefined) {
        return yield* createConversationHydrateResponse({
          ctx,
          registry,
          session,
          sessionId,
          conversationId: requestedConversationId!,
          parsedOffset,
        });
      }

      return yield* createProtocolReadResponse({
        ctx,
        registry,
        session,
        sessionId,
        startLSN,
        isReconnect,
        parsedOffset,
        liveMode,
        timeoutMs,
        log,
      });
    },
    {
      defaultHeaders: {
        "Content-Type": "application/x-ndjson",
      },
      serialize: (v) => v + "\n",
      onSetupError: (error, ctx) => {
        // Return NDJSON error event instead of plain JSON
        const errorEvent = {
          lsn: 0,
          event: {
            type: "RUN_ERROR",
            message: error.message,
            code: "internal_error",
          },
        };
        const body = JSON.stringify(errorEvent) + "\n";
        return new Response(body, {
          status: 200, // Stream "succeeded" but contains error event
          headers: ctx.headers,
        });
      },
    },
  );
}
