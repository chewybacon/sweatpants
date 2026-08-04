/**
 * Durable conversation wire projection.
 *
 * Everything that turns internal stream events, buffered frames, and open
 * interrupt records into the public AG-UI wire view: metadata sanitization,
 * snapshot boundary extraction, checkpoint snapshot construction, and the
 * pending-resume consistency invariant.
 */
import { EventType } from "@ag-ui/core";
import { resource, type Operation, type Stream } from "effection";
import type { StreamEvent } from "./handler/types.ts";
import {
  agUiMessagesToInternalMessages,
  buildAgUiCustomState,
  createChatProjection,
  foldChatStreamEvent,
  materializeChatMessages,
  projectChatMessagesToWire,
  toProviderHistorySnapshot,
  type ChatSessionStreamEvent as ChatStreamEvent,
  type DurableFrame,
  type ElicitRequestStreamEvent,
} from "@sweatpants/chat-core";
import type { OpenInterruptRecord } from "./interrupts/index.ts";

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
  NonNullable<Extract<ChatStreamEvent, { type: EventType.RUN_FINISHED }>["outcome"]>,
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

export function parseBufferedFrames(tokens: StreamEvent[]): DurableFrame[] {
  return tokens.map((event, index) => ({ lsn: index + 1, event }));
}

export function createSyntheticFrameStream(frames: DurableFrame[]): Stream<string, void> {
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

export function initialSnapshotBoundary(frames: DurableFrame[]): {
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
    ? agUiMessagesToInternalMessages(boundary.messages.messages)
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

function activityProjectionEventsFromFrames(frames: readonly DurableFrame[]): StreamEvent[] {
  const latest = new Map<
    string,
    { index: number; event: Extract<StreamEvent, { type: EventType.ACTIVITY_SNAPSHOT }> }
  >();
  for (let index = 0; index < frames.length; index += 1) {
    const event = frames[index]!.event;
    if (event.type === EventType.ACTIVITY_SNAPSHOT) {
      latest.set(event.messageId, { index, event });
    }
  }

  const snapshots = [...latest.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ event }) => event);
  const deltas = frames
    .filter(
      (
        frame,
      ): frame is DurableFrame & {
        event: Extract<StreamEvent, { type: EventType.ACTIVITY_DELTA }>;
      } => frame.event.type === EventType.ACTIVITY_DELTA,
    )
    .filter((frame) => {
      const snapshot = latest.get(frame.event.messageId);
      return snapshot !== undefined && frames.indexOf(frame) > snapshot.index;
    })
    .map((frame) => frame.event);
  return [...snapshots, ...deltas];
}

function providerHistoryFromFrames(frames: readonly DurableFrame[]) {
  let projection = createChatProjection();
  for (const frame of frames) {
    if (
      frame.event.type !== EventType.ACTIVITY_SNAPSHOT &&
      frame.event.type !== EventType.ACTIVITY_DELTA
    ) {
      projection = foldChatStreamEvent(projection, frame.event);
    }
  }
  return projectChatMessagesToWire(materializeChatMessages(projection, { allowPending: true })).map(
    (message) => {
      if (message.role !== "tool") {
        return message;
      }
      const { name: _name, isError: _isError, ...official } = message;
      return official;
    },
  );
}

export function* buildCheckpointSnapshotEventsFromFrames(
  frames: DurableFrame[],
): Operation<StreamEvent[]> {
  return [
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...providerHistoryFromFrames(frames)],
    },
    ...activityProjectionEventsFromFrames(frames),
  ];
}

/**
 * Synthesize the replay projection of a completed conversation: history
 * snapshot, activity snapshots, derived pending-elicit state, and (when
 * interrupts remain open) a terminal RUN_FINISHED interrupt marker.
 */
export function* completedConversationHydrateEvents(params: {
  frames: DurableFrame[];
  conversationId: string;
  runId: string;
  openInterrupts: OpenInterruptRecord[];
  elicits: ElicitRequestStreamEvent[];
}): Operation<StreamEvent[]> {
  const { frames, conversationId, runId, openInterrupts, elicits } = params;
  return [
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...providerHistoryFromFrames(frames)],
    },
    ...activityProjectionEventsFromFrames(frames),
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
