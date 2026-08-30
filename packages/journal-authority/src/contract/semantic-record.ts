import type { OperationOutcome } from "@sweatpants/durable-effects";
import type { DurableOperationDescriptor } from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";

import type { AssistantPartialAcceptedFact, ModelContextPreparedFact } from "./authority-types.ts";
import type { ForkGroupTerminal, ForkPolicy } from "../forest/fork-group.ts";

/** Closed attempt-state algebra persisted by the authority. */
export type DurableAttemptState = "started" | "detached" | "completed" | "revoked" | "superseded";

/** Append-only semantic journal record; payload variants are replay-stable. */
export type DurableSemanticRecord = {
  offset: string;
  eventId: string;
  sessionId: string;
  ownerEpoch?: number;
  payload:
    | {
        type: "TaskOpened";
        taskId: string;
        turnId: string;
        programId: string;
        programVersion: string;
        programDigest: string;
        input: Json;
        inputDigest: string;
        catalog?: Json;
        catalogDigest?: string;
        parentTaskId?: string;
        parentPullId?: string;
        elicitAudience?: string;
      }
    | {
        type: "AdvancementBound";
        taskId: string;
        ownerId: string;
        leaseEpoch: number;
        expiresAtMs: number;
        strandHeadDigest: string;
        forkGroupRevision: number;
        frontierDigest: string;
      }
    | {
        type: "AdvancementReleased";
        taskId: string;
        leaseEpoch: number;
        reason: "parked" | "settled" | "terminal" | "failed" | "scope_exit";
      }
    | {
        type: "PullRequested";
        taskId: string;
        turnId: string;
        actionIndex: number;
        pullIndex: number;
        pullId: string;
        descriptor: DurableOperationDescriptor;
        descriptorDigest: string;
        publicMessageId?: string;
      }
    | {
        type: "ModelContextPrepared";
        taskId: string;
        pullId: string;
        attemptId: string;
        fact: ModelContextPreparedFact;
        preparationDigest: string;
      }
    | {
        type: "AssistantPartialAccepted";
        taskId: string;
        pullId: string;
        attemptId: string;
        fact: AssistantPartialAcceptedFact;
        factDigest: string;
      }
    | {
        type: "AttemptStarted";
        taskId: string;
        pullId: string;
        attemptId: string;
        attemptIndex: number;
      }
    | { type: "AttemptDetached"; taskId: string; pullId: string; attemptId: string; reason: string }
    | {
        type: "AttemptAbandoned";
        taskId: string;
        pullId: string;
        attemptId: string;
        reason: string;
      }
    | {
        type: "AttemptSuperseded";
        taskId: string;
        pullId: string;
        attemptId: string;
        winnerAttemptId: string;
      }
    | { type: "PullIndeterminate"; taskId: string; pullId: string; attemptId: string }
    | {
        type: "PullResolved";
        taskId: string;
        pullId: string;
        attemptId?: string;
        outcome: OperationOutcome;
        outcomeDigest: string;
      }
    | {
        type: "DurableEmission";
        taskId: string;
        actionIndex: number;
        emissionIndex: number;
        descriptor: { eventType: string; payload: Json };
        descriptorDigest: string;
      }
    | {
        type: "RaceWinnerSelected";
        taskId: string;
        pullId: string;
        winnerTaskId: string;
        closeOffset: string;
        outcomeDigest: string;
      }
    | {
        type: "ForkGroupOpened";
        taskId: string;
        pullId: string;
        groupId: string;
        policy: ForkPolicy;
        deadlineMs: number;
        memberTaskIds: readonly string[];
        descriptorDigest: string;
      }
    | {
        type: "ForkGroupBreached";
        taskId: string;
        groupId: string;
        deadlineMs: number;
        breachedAtMs: number;
      }
    | {
        type: "ForkGroupResolved";
        taskId: string;
        pullId: string;
        groupId: string;
        terminal: ForkGroupTerminal;
        terminalDigest: string;
      }
    | {
        type: "ForkGroupOrphaned";
        taskId: string;
        pullId: string;
        groupId: string;
        reason: string;
      }
    | {
        type: "PeerDelegationCommitted";
        taskId: string;
        groupId: string;
        memberTaskId: string;
        correlator: string;
        peer: string;
        deadlineMs: number;
      }
    | {
        type: "CancellationRequested";
        taskId: string;
        commandId: string;
        reason?: string;
        frontier: { actionIndex: number; pullId?: string };
      }
    | {
        type: "CancellationPartialDiscarded";
        taskId: string;
        pullId: string;
        reason: "schema_validation_failed" | "payload_too_large" | "schema_version_unavailable";
      }
    | {
        type: "AttemptOutcomeUnknown";
        taskId: string;
        pullId: string;
        attemptId?: string;
        reason: "no_settlement_path" | "force_orphaned";
      }
    | {
        type: "CleanupSkipped";
        taskId: string;
        reason:
          | "program_version_unavailable"
          | "program_corrupt"
          | "cleanup_stuck"
          | "replay_execution_failed"
          | "replay_diverged";
      }
    | {
        type: "TaskOrphaned";
        taskId: string;
        reason:
          | "program_version_unavailable"
          | "program_corrupt"
          | "cleanup_stuck"
          | "replay_execution_failed"
          | "replay_diverged";
      }
    | { type: "TaskClosed"; taskId: string; outcome: OperationOutcome };
};
