/**
 * Durable conversation wire projection.
 *
 * Everything that turns internal stream events, buffered frames, and open
 * interrupt records into the public AG-UI wire view: metadata sanitization,
 * snapshot boundary extraction, checkpoint snapshot construction, and the
 * pending-resume consistency invariant.
 */
import { resource, type Operation, type Stream } from "effection";
import type { StreamEvent } from "../types.ts";
import { buildAgUiCustomState } from "@sweatpants/chat-core";
import { activitySnapshotsForMessages, toProviderHistorySnapshot } from "@sweatpants/chat-core";
import { agUiMessagesToInternalMessages } from "@sweatpants/chat-core";
import { replayFramesToConversation, type DurableFrame } from "@sweatpants/chat-core";
import type { ElicitRequestStreamEvent } from "@sweatpants/chat-core";
import type { OpenInterruptRecord } from "./interrupt-registry.ts";
import { isRecord } from "./request-normalization.ts";

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

/** Project an internal stream event to its public wire form, or null to drop it. */
export function toStrictPublicEvent(event: StreamEvent): StreamEvent | null {
  switch (event.type) {
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

// =============================================================================
// OPEN INTERRUPT PROJECTION
// =============================================================================

export function recordToElicit(record: OpenInterruptRecord): ElicitRequestStreamEvent | null {
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

export function publicInterruptsFromRecords(records: OpenInterruptRecord[]) {
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

export function sanitizeBoundarySnapshot(boundary: ReturnType<typeof initialSnapshotBoundary>): {
  messages: {
    type: "MESSAGES_SNAPSHOT";
    messages: ReturnType<typeof toProviderHistorySnapshot>;
  } | null;
  activities: Array<Extract<StreamEvent, { type: "ACTIVITY_SNAPSHOT" }>>;
  state: Extract<StreamEvent, { type: "STATE_SNAPSHOT" }> | null;
  nextIndex: number;
} {
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

export function* buildCheckpointSnapshotEventsFromFrames(
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
  const replay = yield* replayFramesToConversation(frames);
  return [
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
