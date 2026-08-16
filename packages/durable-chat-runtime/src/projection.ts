/**
 * Durable conversation wire projection.
 *
 * Everything that turns internal stream events, buffered frames, and open
 * interrupt records into the public AG-UI wire view: metadata sanitization,
 * snapshot boundary extraction, checkpoint snapshot construction, and the
 * pending-resume consistency invariant.
 */
import { EventType, type AGUIEvent } from "@ag-ui/core";
import {
  note,
  runProjectionProgram,
  stage,
  type ProjectionProgram,
} from "@sweatpants/foundation/projection";
import { resource, type Operation, type Stream } from "effection";
import type { StreamEvent } from "./handler/types.ts";
import {
  agUiMessagesToChatHistoryEntries,
  buildAgUiCustomState,
  createChatProjection,
  foldAGUIEvent,
  isConversationAuthorityFrame,
  isConversationWindowFrame,
  materializeChatMessages,
  projectChatMessagesToAGUI,
  toProviderHistorySnapshot,
  type ElicitRequestStreamEvent,
} from "@sweatpants/chat-core";
import type { OpenInterruptRecord } from "./interrupts/index.ts";

export type ProjectionFrame = {
  readonly lsn: number;
  readonly event: StreamEvent;
};

// =============================================================================
// PUBLIC METADATA SANITIZATION
// =============================================================================

const PUBLIC_SWEATPANTS_METADATA_KEYS = new Set(["sweatpants/toolName", "sweatpants/key"]);

export function sanitizePublicMetadata(
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

function withPublicMetadata<T extends object>(
  value: T,
): Omit<T, "metadata"> & { metadata?: Record<string, unknown> } {
  const candidate = "metadata" in value ? value.metadata : undefined;
  const rawMetadata =
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : undefined;
  const { metadata: _ignored, ...rest } = value as T & { metadata?: unknown };
  const metadata = sanitizePublicMetadata(rawMetadata);
  return {
    ...rest,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

type RunFinishedInterrupt = Extract<
  NonNullable<Extract<AGUIEvent, { type: EventType.RUN_FINISHED }>["outcome"]>,
  { type: "interrupt" }
>["interrupts"][number];

/** Project an internal stream event to its public wire form, or null to drop it. */
export function toStrictPublicEvent(event: StreamEvent): StreamEvent | null {
  switch (event.type) {
    case EventType.RUN_FINISHED: {
      const runFinished = event;
      if (runFinished.outcome?.type !== "interrupt") {
        return runFinished;
      }
      return {
        ...runFinished,
        outcome: {
          ...runFinished.outcome,
          interrupts: runFinished.outcome.interrupts.map((interrupt: RunFinishedInterrupt) =>
            withPublicMetadata(interrupt),
          ),
        },
      };
    }
    default:
      return event;
  }
}

// =============================================================================
// OPEN INTERRUPT PROJECTION
// =============================================================================

export function recordToElicit(record: OpenInterruptRecord): ElicitRequestStreamEvent | null {
  if (!record.toolCallId || !record.toolName) {
    return null;
  }
  return {
    type: "elicit_request",
    sessionId: record.toolCallId,
    callId: record.toolCallId,
    toolName: record.toolName,
    elicitId: record.interruptId,
    key:
      typeof record.publicMetadata?.["sweatpants/key"] === "string"
        ? String(record.publicMetadata["sweatpants/key"])
        : record.interruptId,
    message: record.message ?? "Input required",
    ...(record.responseSchema ? { schema: record.responseSchema } : {}),
    ...(record.bindingId ? { bindingId: record.bindingId } : {}),
    ...(record.context !== undefined ? { context: record.context } : {}),
    ...(record.responseContract ? { responseContract: record.responseContract } : {}),
    ...(record.contextContract ? { contextContract: record.contextContract } : {}),
    ...(record.placement ? { placement: record.placement } : {}),
  };
}

export function publicInterruptsFromRecords(records: OpenInterruptRecord[]) {
  return records.map((record) => {
    const metadata = sanitizePublicMetadata(record.publicMetadata);
    return {
      id: record.interruptId,
      reason: record.reason,
      ...(record.message ? { message: record.message } : {}),
      ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
      ...(record.responseSchema ? { responseSchema: record.responseSchema } : {}),
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

/** Derive the consistent elicit view for a thread's open interrupts. */
export function elicitsForOpenInterrupts(
  openInterrupts: OpenInterruptRecord[],
): ElicitRequestStreamEvent[] {
  const elicits = openInterrupts
    .map(recordToElicit)
    .filter((value): value is ElicitRequestStreamEvent => value !== null);
  assertPendingResumeConsistency(elicits, openInterrupts);
  return elicits;
}

// =============================================================================
// FRAME / SNAPSHOT PROJECTION
// =============================================================================

export function parseBufferedFrames(tokens: StreamEvent[]): ProjectionFrame[] {
  return tokens.map((event, index) => ({ lsn: index + 1, event }));
}

export function createSyntheticFrameStream(frames: ProjectionFrame[]): Stream<string, void> {
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

export function initialSnapshotBoundary(frames: ProjectionFrame[]): {
  messages: Extract<StreamEvent, { type: EventType.MESSAGES_SNAPSHOT }> | null;
  state: Extract<StreamEvent, { type: EventType.STATE_SNAPSHOT }> | null;
  nextIndex: number;
} {
  let index = 0;
  if (frames[index]?.event.type === EventType.RUN_STARTED) {
    index += 1;
  }

  const messages =
    frames[index]?.event.type === EventType.MESSAGES_SNAPSHOT
      ? (frames[index++]!.event as Extract<StreamEvent, { type: EventType.MESSAGES_SNAPSHOT }>)
      : null;

  const state =
    frames[index]?.event.type === EventType.STATE_SNAPSHOT
      ? (frames[index++]!.event as Extract<StreamEvent, { type: EventType.STATE_SNAPSHOT }>)
      : null;

  return { messages, state, nextIndex: index };
}

export function sanitizeBoundarySnapshot(boundary: ReturnType<typeof initialSnapshotBoundary>): {
  messages: {
    type: EventType.MESSAGES_SNAPSHOT;
    messages: ReturnType<typeof toProviderHistorySnapshot>;
  } | null;
  state: Extract<StreamEvent, { type: EventType.STATE_SNAPSHOT }> | null;
  nextIndex: number;
} {
  const internalMessages = boundary.messages
    ? agUiMessagesToChatHistoryEntries(boundary.messages.messages)
    : [];
  const messages = boundary.messages
    ? {
        type: EventType.MESSAGES_SNAPSHOT as const,
        messages: toProviderHistorySnapshot(internalMessages),
      }
    : null;
  return {
    messages,
    state: boundary.state,
    nextIndex: boundary.nextIndex,
  };
}

export type ConversationReplayNote =
  | {
      readonly kind: "frames-replayed";
      readonly frames: number;
      readonly providerEvents: number;
      readonly activityEvents: number;
    }
  | { readonly kind: "provider-history-materialized"; readonly messages: number }
  | { readonly kind: "activity-snapshots-materialized"; readonly snapshots: number };

type ProviderHistoryMessage =
  | Exclude<ReturnType<typeof projectChatMessagesToAGUI>[number], { readonly role: "tool" }>
  | Omit<
      Extract<ReturnType<typeof projectChatMessagesToAGUI>[number], { readonly role: "tool" }>,
      "name" | "isError"
    >;

export interface ConversationReplayViews {
  readonly providerMessages: readonly ProviderHistoryMessage[];
  readonly activitySnapshots: readonly StreamEvent[];
}

interface ConversationReplayFacts {
  readonly providerProjection: ReturnType<typeof createChatProjection>;
  readonly activityProjection: ReturnType<typeof createChatProjection>;
  readonly activityRecordOrder: readonly string[];
}

interface ConversationReplayOptions {
  readonly includeActivity: boolean;
}

function* replayConversationFrames(
  frames: readonly ProjectionFrame[],
  options: ConversationReplayOptions,
): ProjectionProgram<ConversationReplayFacts, ConversationReplayNote> {
  return yield* stage("replay-frames", function* () {
    let providerProjection = createChatProjection();
    let activityProjection = createChatProjection();
    const activityRecordOrder: string[] = [];
    const seenActivityRecords = new Set<string>();
    let providerEvents = 0;
    let activityEvents = 0;

    for (const frame of frames) {
      const event = frame.event;
      if (isConversationAuthorityFrame(event) || isConversationWindowFrame(event)) {
        continue;
      }
      if (event.type === EventType.ACTIVITY_SNAPSHOT || event.type === EventType.ACTIVITY_DELTA) {
        if (!options.includeActivity) {
          continue;
        }
        if (
          event.type === EventType.ACTIVITY_SNAPSHOT &&
          !seenActivityRecords.has(event.messageId)
        ) {
          seenActivityRecords.add(event.messageId);
          activityRecordOrder.push(event.messageId);
        }
        activityProjection = foldAGUIEvent(activityProjection, event);
        activityEvents += 1;
        continue;
      }
      providerProjection = foldAGUIEvent(providerProjection, event);
      providerEvents += 1;
    }

    yield* note({
      kind: "frames-replayed",
      frames: frames.length,
      providerEvents,
      activityEvents,
    });
    return { providerProjection, activityProjection, activityRecordOrder };
  });
}

function providerHistoryFromProjection(
  projection: ReturnType<typeof createChatProjection>,
): ConversationReplayViews["providerMessages"] {
  return projectChatMessagesToAGUI(materializeChatMessages(projection, { allowPending: true })).map(
    (message) => {
      if (message.role !== "tool") {
        return message;
      }
      const { name: _name, isError: _isError, ...official } = message;
      return official;
    },
  );
}

function activitySnapshotsFromProjection(
  projection: ConversationReplayFacts,
): readonly StreamEvent[] {
  return projection.activityRecordOrder.flatMap((activityRecordId) => {
    const nodeId = projection.activityProjection.activityNodeByRecordId.get(activityRecordId);
    const projected = nodeId ? projection.activityProjection.nodes.get(nodeId) : undefined;
    if (!projected || projected.synthetic) return [];
    return [
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: activityRecordId,
        activityType: "sweatpants:public-execution",
        content: { version: 1 as const, node: projected.node },
        replace: true,
      },
    ];
  });
}

/**
 * Replay frames once and materialize both public hydration views. The replay
 * stage owns the shared fold; the materialization stages own their respective
 * wire representations.
 */
export function* conversationReplayProjection(
  frames: readonly ProjectionFrame[],
): ProjectionProgram<ConversationReplayViews, ConversationReplayNote> {
  const facts = yield* replayConversationFrames(frames, { includeActivity: true });
  const providerMessages = yield* stage("provider-history", function* () {
    const messages = providerHistoryFromProjection(facts.providerProjection);
    yield* note({ kind: "provider-history-materialized", messages: messages.length });
    return messages;
  });
  const activitySnapshots = yield* stage("activity-snapshots", function* () {
    const snapshots = activitySnapshotsFromProjection(facts);
    yield* note({ kind: "activity-snapshots-materialized", snapshots: snapshots.length });
    return snapshots;
  });
  return { providerMessages, activitySnapshots };
}

function* providerHistoryProjection(
  frames: readonly ProjectionFrame[],
): ProjectionProgram<ConversationReplayViews["providerMessages"], ConversationReplayNote> {
  const facts = yield* replayConversationFrames(frames, { includeActivity: false });
  return yield* stage("provider-history", function* () {
    const messages = providerHistoryFromProjection(facts.providerProjection);
    yield* note({ kind: "provider-history-materialized", messages: messages.length });
    return messages;
  });
}

function runConversationProjection<TValue>(
  program: () => ProjectionProgram<TValue, ConversationReplayNote>,
): TValue {
  const outcome = runProjectionProgram(program, (error) => error);
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Replay only provider-facing messages, without folding activity records. */
export function providerHistoryFromFrames(frames: readonly ProjectionFrame[]) {
  return runConversationProjection(() => providerHistoryProjection(frames));
}

/** Replay and materialize the provider and activity hydration views. */
export function replayConversationViews(frames: readonly ProjectionFrame[]) {
  return runConversationProjection(() => conversationReplayProjection(frames));
}

export function* buildCheckpointSnapshotEventsFromFrames(
  frames: ProjectionFrame[],
): Operation<StreamEvent[]> {
  const views = replayConversationViews(frames);
  return [
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...views.providerMessages],
    },
    ...views.activitySnapshots,
  ];
}

/**
 * Synthesize the replay projection of a completed conversation: history
 * snapshot, activity snapshots, derived pending-elicit state, and (when
 * interrupts remain open) a terminal RUN_FINISHED interrupt marker.
 */
export function* completedConversationHydrateEvents(params: {
  frames: ProjectionFrame[];
  conversationId: string;
  runId: string;
  openInterrupts: OpenInterruptRecord[];
  elicits: ElicitRequestStreamEvent[];
}): Operation<StreamEvent[]> {
  const { frames, conversationId, runId, openInterrupts, elicits } = params;
  const views = replayConversationViews(frames);
  return [
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...views.providerMessages],
    },
    ...views.activitySnapshots,
    {
      type: EventType.STATE_SNAPSHOT,
      snapshot: buildAgUiCustomState({ elicits }),
    },
    ...(openInterrupts.length > 0
      ? [
          {
            type: EventType.RUN_FINISHED as const,
            threadId: conversationId,
            runId,
            outcome: {
              type: "interrupt" as const,
              interrupts: publicInterruptsFromRecords(openInterrupts),
            },
          },
        ]
      : []),
  ];
}
