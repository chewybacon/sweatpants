import { EventType } from "@ag-ui/core";
import {
  createChatTurnCompletedFact,
  projectChatTurnFacts,
  CONVERSATION_AUTHORITY_FRAME_TYPE,
} from "@sweatpants/chat-core";
import { assertJson, stableTupleHash } from "@sweatpants/foundation";
import { LOW_CHECKPOINT_TARGETS } from "@sweatpants/history-store";
import { conversationAuthority } from "../conversation-authority.ts";
import {
  buildConversationWindow,
  persistConversationCheckpoint,
} from "../conversation-persistence.ts";
import { completeAndPublishTurn, type BeginTurnPublicationRequest } from "../index.ts";
import { cancelOpenInterruptsForThread } from "../interrupts/index.ts";
import type { ChatExecutionContext } from "./chat-execution-context.ts";
import type { ChatRequestContext } from "./chat-stream-endpoint.ts";
import type { LiveProgramActivation } from "./turn-recovery.ts";
import type { WorkflowChatEngineParams } from "./types.ts";

/** Publishes parked and terminal authority before exposing their response events. */
export function createTurnPublishers(
  execution: ChatExecutionContext,
  context: ChatRequestContext,
  authorityTurn: BeginTurnPublicationRequest | undefined,
  liveActivation: LiveProgramActivation | null,
): Pick<WorkflowChatEngineParams, "publishCheckpoint" | "publishTerminal"> {
  const { config, storage, projectionTokens } = execution;
  const { body, stores, conversationId: requestedConversationId } = context;
  const agUiThreadId = requestedConversationId;
  const checkpointTargets = storage.profile === "low" ? LOW_CHECKPOINT_TARGETS : undefined;
  return {
    publishCheckpoint: function* ({ events }) {
      if (!authorityTurn) {
        throw new Error("Parked checkpoint has no authoritative Turn");
      }
      const parkedHead = yield* stores.conversation.loadHead(requestedConversationId);
      if (!parkedHead || parkedHead.activeExecutionId !== authorityTurn.executionId) {
        throw new Error("Parked checkpoint lost its authoritative Turn");
      }
      const encodedEvents = events.map((event) => assertJson(event));
      const persisted = yield* persistConversationCheckpoint({
        conversationId: requestedConversationId,
        causeKey: stableTupleHash([authorityTurn.executionId, "parked", encodedEvents]),
        cause: {
          kind: "tail-cut",
          cutKind: "parked",
          executionId: authorityTurn.executionId,
          logicalTurnId: authorityTurn.turnId,
        },
        roots: encodedEvents,
        targets: checkpointTargets,
        expectedRevision: parkedHead.revision,
        expectedOwnerEpoch: parkedHead.ownerEpoch,
        expectedExecutionId: authorityTurn.executionId,
        proposal: {
          state: "parked",
          terminalHistory: parkedHead.terminalHistory,
          activeLogicalTurnId: parkedHead.activeLogicalTurnId,
          activeExecutionId: parkedHead.activeExecutionId,
          latestCompletedExecutionId: parkedHead.latestCompletedExecutionId,
          activeSegment: parkedHead.activeSegment,
          activeCommand: parkedHead.activeCommand,
          deletedAt: parkedHead.deletedAt,
        },
        createdAt: Date.now(),
      });
      const publication = {
        authority: conversationAuthority(requestedConversationId, persisted.head),
        /* CONDITIONAL-SPREAD: Expose window only when its backing capability exists; callers inspect supported methods. */
        ...(projectionTokens
          ? {
              window: yield* buildConversationWindow({
                conversationId: requestedConversationId,
                head: persisted.head,
                checkpoint: persisted.checkpoint,
                keyring: projectionTokens,
                knownWindowToken: body.knownWindowToken || undefined,
                tokenTtlMs: config.projectionTokenTtlMs,
              }),
            }
          : {}),
      };
      const interrupt = events.filter((event) => event.type === EventType.RUN_FINISHED).at(-1);
      if (interrupt) {
        liveActivation?.publication.resolve([
          ...(publication.window
            ? [publication.window]
            : events.filter((event) => event.type !== EventType.RUN_FINISHED)),
          { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: publication.authority },
          interrupt,
        ]);
      }
      return publication;
    },
    publishTerminal: function* ({ outcome, disposition, events }) {
      if (!authorityTurn) {
        throw new Error("Recovered terminal publication cannot execute workflow host");
      }
      const fact = createChatTurnCompletedFact({
        executionId: authorityTurn.executionId,
        sessionId: authorityTurn.sessionId,
        turnId: authorityTurn.turnId,
        outcome,
        events: events.map((event) => assertJson(event)),
      });
      yield* completeAndPublishTurn({
        executionId: authorityTurn.executionId,
        outcome: { storage: "inline", value: outcome },
        disposition,
        completedAt: Date.now(),
        facts: [fact],
        project: projectChatTurnFacts,
      });
      const terminalHead = yield* stores.conversation.loadHead(requestedConversationId);
      if (disposition === "cancelled") {
        cancelOpenInterruptsForThread(agUiThreadId);
      }
      liveActivation?.publication.resolve([]);
      const terminalCheckpoint = terminalHead?.checkpoint
        ? yield* stores.conversation.getCheckpoint(terminalHead.checkpoint)
        : null;
      return {
        authority: conversationAuthority(requestedConversationId, terminalHead),
        /* CONDITIONAL-SPREAD: Expose window only when its backing capability exists; callers inspect supported methods. */
        ...(terminalHead && terminalCheckpoint
          ? {
              window: yield* buildConversationWindow({
                conversationId: requestedConversationId,
                head: terminalHead,
                checkpoint: terminalCheckpoint,
                keyring: projectionTokens,
                knownWindowToken: body.knownWindowToken || undefined,
                tokenTtlMs: config.projectionTokenTtlMs,
              }),
            }
          : {}),
      };
    },
  };
}
