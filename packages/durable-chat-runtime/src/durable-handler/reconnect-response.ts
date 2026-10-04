import type { ConversationStreamEvent as StreamEvent } from "@sweatpants/chat-core";
import { useLogger } from "../logger/index.ts";
import type { SessionRegistry } from "../response-streams/index.ts";
import type { LiveProgramActivation } from "./turn-recovery.ts";

/** Reuses a live response segment, or selects durable recovery after its writer is lost. */
export function* reconnectResponse(
  activeExecutionId: string | null,
  registry: SessionRegistry<StreamEvent>,
  sessionId: string,
  selectedLiveActivation: LiveProgramActivation | undefined,
) {
  const log = yield* useLogger("handler:durable");
  // A response buffer is optional delivery state. After host loss it may be
  // gone entirely; recovery must reach the journal without acquiring it first.
  if (activeExecutionId && selectedLiveActivation?.executionId !== activeExecutionId) {
    log.debug({ sessionId }, "reconnect path: detached writer requires recovery");
    return { session: undefined, recoverDetachedSession: true };
  }

  // Replay this command's existing response segment, whose initial window and
  // following incrementals share one frontier. A durable checkpoint paired
  // with the latest buffer offset drops in-flight text and can leave a lone
  // TEXT_MESSAGE_END. The segment starts with bounded history; acquiring it
  // does not restart the writer or model.
  log.debug({ sessionId }, "reconnect path: acquiring existing session");
  const session = yield* registry.acquire(sessionId);
  return { session, recoverDetachedSession: false };
}
