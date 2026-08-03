import { EventType } from "@ag-ui/core";
import { each, type Channel, type Operation, type Stream } from "effection";
import type { ChatStateEvent } from "../state/events.ts";
import type { StreamEvent } from "./streaming.ts";
import type { StreamEventEntry } from "./options.ts";
import type { ChatTransportReceipt } from "./settlement.ts";

/**
 * Consume the framed response transport, forward canonical events unchanged,
 * and enforce the stream lifecycle. Semantic state and turn history belong to
 * the session projection downstream of this transport boundary.
 */
export function* consumeChatEventStream(
  eventStream: Stream<unknown, void>,
  events: Channel<ChatStateEvent, void>,
  onStreamEvent?: (entry: StreamEventEntry) => void,
): Operation<ChatTransportReceipt> {
  let runStarted = false;
  let terminalSeen = false;

  for (const rawFrame of yield* each(eventStream)) {
    const frame = rawFrame as { lsn: number; event: StreamEvent };
    const event = frame.event;
    onStreamEvent?.({ lsn: frame.lsn, event, phase: "live", receivedAt: Date.now() });

    if (event.type === EventType.RUN_STARTED) {
      runStarted = true;
      terminalSeen = false;
    } else if (runStarted && !terminalSeen) {
      if (event.type === EventType.RUN_FINISHED) {
        terminalSeen = true;
      } else if (event.type === EventType.RUN_ERROR) {
        terminalSeen = true;
      }
    }

    yield* events.send(event);
    yield* each.next();
  }

  if (!runStarted) {
    throw new Error("AG-UI stream ended before RUN_STARTED");
  }
  if (!terminalSeen) {
    throw new Error("AG-UI stream ended before RUN_FINISHED or RUN_ERROR");
  }
  return {};
}
