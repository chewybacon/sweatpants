import { action, race, sleep, type Operation } from "effection";
import type { ConversationHead, ConversationStore } from "@sweatpants/history-store/contract";
import type { ProgramDriverJournalStore, ProgramDriverJournal } from "./program-driver-journal.ts";
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

/**
 * A missing local activation does not imply host death: request-scoped hosts
 * never share that map. Observe the durable lease before reclaiming a writer.
 * Foreign readers wait for release or expiry before selecting authoritative
 * state. They do not speculate about writer liveness from delivery progress.
 * Same-host readers retain their existing live subscription path.
 */
interface ForeignActivationRequest {
  head: ConversationHead | null;
  conversationId: string;
  liveActivations: ReadonlyMap<string, LiveProgramActivation>;
  journalStore: ProgramDriverJournalStore;
  conversationStore: Pick<ConversationStore, "loadHead">;
  signal?: AbortSignal;
}

export function* waitForForeignActivation(
  request: ForeignActivationRequest,
): Operation<ConversationHead | null> {
  request.signal?.throwIfAborted();
  if (!request.signal) {
    return yield* selectForeignActivation(request);
  }
  const signal = request.signal;
  return yield* race([
    selectForeignActivation(request),
    action<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      return () => signal.removeEventListener("abort", abort);
    }),
  ]);
}

function* selectForeignActivation(
  request: ForeignActivationRequest,
): Operation<ConversationHead | null> {
  let head = request.head;
  let journal: ProgramDriverJournal | undefined;
  while (
    head?.activeExecutionId &&
    (head.state === "running" || head.state === "recovering") &&
    request.liveActivations.get(request.conversationId)?.executionId !== head.activeExecutionId
  ) {
    journal ??= yield* request.journalStore.open(request.conversationId);
    const lease = yield* journal.query({
      type: "control.activation-status",
      sessionId: request.conversationId,
    });
    if (lease.remainingMs <= 0) {
      head = yield* request.conversationStore.loadHead(request.conversationId);
      break;
    }
    yield* sleep(Math.min(lease.remainingMs, 1_000));
    head = yield* request.conversationStore.loadHead(request.conversationId);
  }
  return head;
}
