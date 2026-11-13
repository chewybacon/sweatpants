import { EventType } from "@ag-ui/core";
import type {
  ConversationStreamEvent as StreamEvent,
  AgUiRunMetadata,
} from "@sweatpants/chat-core";
import { CrankError } from "@sweatpants/durable-execution";
import type { ConversationHead } from "@sweatpants/history-store/contract";
import { useConversationStore } from "@sweatpants/history-store/port";
import { resource, withResolvers, type Operation, type WithResolvers } from "effection";
import { conversationAuthorityFrame } from "../conversation-authority.ts";
import type { RecoveredTurnPublication } from "../index.ts";
import type { ChatEngineSource } from "../response-streams/index.ts";
import type { ProgramDriverJournalStore } from "./program-driver-journal.ts";

export function* claimDetachedTurnRecovery(request: {
  conversationId: string;
  commandId: string;
  kind: "interrupt-turn" | "recover-writer";
  logicalTurnId: string;
  executionId: string;
}): Operation<ConversationHead> {
  const store = yield* useConversationStore();
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const head = yield* store.loadHead(request.conversationId);
    if (
      !head ||
      head.activeLogicalTurnId !== request.logicalTurnId ||
      head.activeExecutionId !== request.executionId
    ) {
      throw new CrankError(
        "active_turn_changed",
        `Conversation ${request.conversationId} active Turn changed`,
      );
    }
    if (head.state === "idle" || head.state === "deleted") {
      throw new CrankError(
        "active_turn_changed",
        `Conversation ${request.conversationId} has no recoverable active Turn`,
      );
    }
    const activeCommand =
      head.activeCommand &&
      typeof head.activeCommand === "object" &&
      !Array.isArray(head.activeCommand)
        ? head.activeCommand
        : null;
    if (
      head.state === "running" &&
      activeCommand?.["kind"] === request.kind &&
      activeCommand["commandId"] === request.commandId
    ) {
      return head;
    }
    const claimed = yield* store.compareAndSwapHead(
      request.conversationId,
      head.revision,
      head.ownerEpoch,
      {
        state: "running",
        checkpoint: head.checkpoint,
        terminalHistory: head.terminalHistory,
        activeLogicalTurnId: head.activeLogicalTurnId,
        activeExecutionId: head.activeExecutionId,
        latestCompletedExecutionId: head.latestCompletedExecutionId,
        activeSegment: null,
        activeCommand: {
          kind: request.kind,
          commandId: request.commandId,
          logicalTurnId: request.logicalTurnId,
          executionId: request.executionId,
        },
        deletedAt: null,
        ownerTransition: {
          kind: "assign",
          ownerRoute: {
            kind: request.kind,
            commandId: request.commandId,
            executionId: request.executionId,
          },
        },
      },
    );
    if (claimed.status === "committed") {
      return claimed.head;
    }
  }
  throw new CrankError(
    "conversation_state_changed",
    `Conversation ${request.conversationId} recovery claim did not converge`,
  );
}

export function recoveredPublicationEvents(recovery: RecoveredTurnPublication): ChatEngineSource {
  const capsule = recovery.capsule;
  const event: StreamEvent =
    capsule.disposition === "completed"
      ? {
          type: EventType.RUN_FINISHED,
          threadId: capsule.sessionId,
          runId: capsule.turnId,
          outcome: { type: "success" },
        }
      : {
          type: EventType.RUN_ERROR,
          code: `PROGRAM_${capsule.disposition.toUpperCase()}`,
          message: `Program ${capsule.disposition}`,
        };
  return resource(function* (provide) {
    let emitted = false;
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        if (emitted) {
          return { done: true, value: undefined };
        }
        emitted = true;
        return { done: false, value: event };
      },
    });
  });
}

export interface LiveProgramActivation {
  readonly executionId: string;
  readonly taskReady: WithResolvers<string>;
  readonly publication: WithResolvers<readonly StreamEvent[]>;
}

export function createLiveProgramActivation(executionId: string): LiveProgramActivation {
  return {
    executionId,
    taskReady: withResolvers(`live task ${executionId} ready`),
    publication: withResolvers(`live task ${executionId} publication`),
  };
}

export function createLiveCancellationEngine(params: {
  journalStore: ProgramDriverJournalStore;
  activation: LiveProgramActivation;
  conversationId: string;
  reason: string;
  commandId: string;
  agUiRun: AgUiRunMetadata;
}): ChatEngineSource {
  return resource(function* (provide) {
    let events: StreamEvent[] | null = null;
    let index = 0;
    const store = yield* useConversationStore();
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        if (events === null) {
          const taskId = yield* params.activation.taskReady.operation;
          yield* params.journalStore.withJournal(params.conversationId, (journal) =>
            journal.requestCancellation(
              params.conversationId,
              taskId,
              params.reason,
              params.commandId,
            ),
          );
          // The existing activation owns unwind and persists its next boundary.
          // Reuse its cleanup publication, or report terminal cancellation.
          const publication = yield* params.activation.publication.operation;
          if (publication.length > 0) {
            events = publication.map((event) =>
              event.type === EventType.RUN_FINISHED ? { ...event, ...params.agUiRun } : event,
            );
          } else {
            const head = yield* store.loadHead(params.conversationId);
            events = [
              conversationAuthorityFrame(params.conversationId, head),
              {
                type: EventType.RUN_ERROR,
                code: "PROGRAM_CANCELLED",
                message: params.reason,
              },
            ];
          }
        }
        if (index >= events.length) {
          return { done: true, value: undefined };
        }
        return { done: false, value: events[index++]! };
      },
    });
  });
}
