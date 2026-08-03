/**
 * Durable conversation hydrate responses.
 *
 * Read-side responses that reconstruct a conversation's public wire view from
 * a stored checkpoint or from the buffered response stream, without turning
 * the chat engine.
 */
import { EventType } from "@ag-ui/core";
import type { Operation, Subscription } from "effection";
import type { SessionHandle, SessionRegistry } from "../response-streams/index.ts";
import type { StreamEvent } from "./types.ts";
import { buildAgUiCustomState } from "@sweatpants/chat-core";
import { openInterruptsForThread } from "../interrupts/index.ts";
import {
  completedConversationHydrateEvents,
  createSyntheticFrameStream,
  elicitsForOpenInterrupts,
  initialSnapshotBoundary,
  parseBufferedFrames,
  publicInterruptsFromRecords,
  sanitizeBoundarySnapshot,
} from "../projection.ts";
import { createEmptyStream, parseOffsetParam, toOffsetString } from "@sweatpants/durable-streams";

type ParsedOffset = ReturnType<typeof parseOffsetParam>;

interface HydrateResponse {
  subscription: Subscription<string, void>;
  cleanup?: () => Operation<void>;
}

function toFrames(events: StreamEvent[]) {
  return events.map((event, index) => ({ lsn: index + 1, event }));
}

function storedCheckpointHydrateEvents(
  checkpointEvents: StreamEvent[],
  conversationId: string,
): StreamEvent[] {
  const openInterrupts = openInterruptsForThread(conversationId);
  const elicits = elicitsForOpenInterrupts(openInterrupts);

  return [
    ...checkpointEvents,
    {
      type: EventType.STATE_SNAPSHOT,
      snapshot: buildAgUiCustomState({ elicits }),
    },
    ...(openInterrupts.length > 0
      ? [
          {
            type: EventType.RUN_FINISHED as const,
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

export function* createStoredConversationCheckpointResponse(params: {
  ctx: { request: Request; headers: Headers; status?: number };
  conversationId: string;
  checkpointEvents: StreamEvent[];
  parsedOffset: ParsedOffset;
}): Operation<HydrateResponse> {
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
    toFrames(storedCheckpointHydrateEvents(checkpointEvents, conversationId)),
  );

  return { subscription };
}

export function* createConversationHydrateResponse(params: {
  ctx: { request: Request; headers: Headers };
  registry: SessionRegistry<StreamEvent>;
  session: SessionHandle<StreamEvent>;
  sessionId: string;
  conversationId: string;
  parsedOffset: ParsedOffset;
}): Operation<HydrateResponse> {
  const { ctx, registry, session, sessionId, conversationId, parsedOffset } = params;
  const { tokens, lsn } = yield* session.buffer.read(0);
  const frames = parseBufferedFrames(tokens);
  const complete = yield* session.buffer.isComplete();
  const openInterrupts = openInterruptsForThread(conversationId);
  const elicits = elicitsForOpenInterrupts(openInterrupts);
  const offsetRequested = new URL(ctx.request.url).searchParams.has("offset");
  let resetRequested = false;

  ctx.headers.set("Stream-Next-Offset", toOffsetString(lsn));

  let syntheticEvents: StreamEvent[] = [];

  if (complete) {
    resetRequested = offsetRequested && !parsedOffset.isNow;
    syntheticEvents = yield* completedConversationHydrateEvents({
      frames,
      conversationId,
      runId: openInterrupts[0]?.interruptedRunId ?? sessionId,
      openInterrupts,
      elicits,
    });
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
      ...(boundary.state
        ? [boundary.state]
        : [
            {
              type: EventType.STATE_SNAPSHOT as const,
              snapshot: buildAgUiCustomState({ elicits }),
            },
          ]),
      ...frames.slice(tailStartIndex).map((frame) => frame.event),
    ];
  }

  if (resetRequested) {
    ctx.headers.set("Stream-Cursor-Reset", "true");
  }

  const subscription = yield* createSyntheticFrameStream(toFrames(syntheticEvents));
  return {
    subscription,
    cleanup: function* () {
      yield* registry.release(sessionId);
    },
  };
}
