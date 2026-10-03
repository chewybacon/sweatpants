import { EventType } from "@ag-ui/core";
import type { ConversationStreamEvent as StreamEvent } from "@sweatpants/chat-core";
import { CrankError } from "@sweatpants/durable-execution";
import { conversationAuthorityFrame } from "../conversation-authority.ts";
import { buildConversationWindow } from "../conversation-persistence.ts";
import { useLogger } from "../logger/index.ts";
import type { SessionHandle, SessionRegistry } from "../response-streams/index.ts";
import type { ChatExecutionContext } from "./chat-execution-context.ts";
import type { ChatRequestContext } from "./chat-stream-endpoint.ts";
import type { LiveProgramActivation } from "./turn-recovery.ts";
import type { ToolSchema } from "./types.ts";

/** Reuses a live response tail, or releases it so the caller can recover its detached writer. */
export function* reconnectResponse(
  execution: ChatExecutionContext,
  context: ChatRequestContext,
  registry: SessionRegistry<StreamEvent>,
  sessionId: string,
  toolSchemas: ToolSchema[],
  selectedLiveActivation: LiveProgramActivation | undefined,
) {
  const { config, projectionTokens } = execution;
  const {
    body,
    stores,
    selectedHead: resolvedHead,
    conversationId: requestedConversationId,
  } = context;
  const agUiThreadId = requestedConversationId;
  const log = yield* useLogger("handler:durable");
  let session: SessionHandle<StreamEvent> | undefined;
  let recoverDetachedSession = false;
  let responsePrefix: readonly StreamEvent[] = [];
  let responseStartLSN = 0;
  // A response cursor selects presentation replay only. If its
  // writer is detached while durable authority remains active,
  // release this reader and offer the session a fenced recovery
  // source instead of treating the incomplete buffer as truth.
  log.debug({ sessionId }, "reconnect path: acquiring existing session");
  session = yield* registry.acquire(sessionId);
  const responseComplete = yield* session.buffer.isComplete();
  recoverDetachedSession =
    Boolean(resolvedHead?.activeExecutionId) &&
    selectedLiveActivation?.executionId !== resolvedHead?.activeExecutionId &&
    !responseComplete;
  if (recoverDetachedSession) {
    yield* registry.release(sessionId);
    session = undefined;
    log.debug({ sessionId }, "reconnect path: detached writer requires recovery");
  } else {
    log.debug({ sessionId }, "reconnect path: session acquired");
    const reconnectHead = yield* stores.conversation.loadHead(requestedConversationId);
    const reconnectCheckpoint = reconnectHead?.checkpoint
      ? yield* stores.conversation.getCheckpoint(reconnectHead.checkpoint)
      : null;
    if (!reconnectHead || !reconnectCheckpoint || !reconnectHead.activeLogicalTurnId) {
      throw new CrankError(
        "conversation_state_changed",
        `Conversation ${requestedConversationId} lost its active reconnect state`,
      );
    }
    if (!session.buffer.readLatest) {
      throw new Error("Response tail does not support bounded latest-position reads");
    }
    responseStartLSN = (yield* session.buffer.readLatest()).lsn;
    responsePrefix = [
      {
        type: EventType.RUN_STARTED,
        threadId: agUiThreadId,
        runId: reconnectHead.activeLogicalTurnId,
        input: {
          threadId: agUiThreadId,
          runId: reconnectHead.activeLogicalTurnId,
          state: body.state ?? {},
          messages: [],
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
      yield* buildConversationWindow({
        conversationId: requestedConversationId,
        head: reconnectHead,
        checkpoint: reconnectCheckpoint,
        keyring: projectionTokens,
        ...(body.knownWindowToken ? { knownWindowToken: body.knownWindowToken } : {}),
        ...(config.projectionTokenTtlMs === undefined
          ? {}
          : { tokenTtlMs: config.projectionTokenTtlMs }),
      }),
      conversationAuthorityFrame(requestedConversationId, reconnectHead),
    ];
  }

  return { session, recoverDetachedSession, responsePrefix, responseStartLSN };
}
