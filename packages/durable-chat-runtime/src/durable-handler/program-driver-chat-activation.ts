import { type Operation } from "effection";
import { type JournalAuthorityContract } from "@sweatpants/journal-authority";
import { CrankError, type AdvancementResult } from "@sweatpants/durable-execution";
import { stableTupleHash } from "@sweatpants/foundation";

import { runWithRenewedActivationLease } from "../host/activation-lease-coordinator.ts";
import { requiresFencedActivation } from "../program-driver/native-tools.ts";
import { admitProgramDriverChatTurn } from "./program-driver-chat-admission.ts";
import {
  cancelPendingElicits,
  disposeForeignChildSessions,
  resolveElicitResponses,
} from "./program-driver-chat-settlement.ts";
import { composeChatExecutionRuntime } from "./program-driver-chat-runtime.ts";
import type {
  ChatActivationReport,
  ProgramDriverChatEngineParams,
} from "./program-driver-chat-types.ts";

export function* runProgramDriverChatActivation(
  params: ProgramDriverChatEngineParams,
): Operation<ChatActivationReport> {
  const admission = yield* admitProgramDriverChatTurn(params);
  const { journal, active, taskId, before, input, attach, replacementQueued } = admission;

  if (active && (params.pluginAbort || replacementQueued)) {
    const reason = params.pluginAbort?.reason ?? "active turn superseded by a new message";
    yield* journal.requestCancellation(
      params.conversationId,
      active.taskId,
      reason,
      params.pluginAbort?.commandId,
    );
    yield* cancelPendingElicits(journal, before, params.conversationId, params.participantId);
    yield* disposeForeignChildSessions(before, params.conversationId);
  }
  const accepted =
    params.pluginAbort || replacementQueued
      ? 0
      : yield* resolveElicitResponses(params, journal, before);
  if (accepted > 0 && params.onResumeAccepted) {
    yield* params.onResumeAccepted();
  }

  const execution = yield* composeChatExecutionRuntime(params, journal, input, attach);
  let cancellationFenceLost = false;
  let outcome: AdvancementResult;
  if (!requiresFencedActivation(params.nativeTools)) {
    outcome = yield* execution.driveTreeAtEpoch(attach.executionEpoch);
  } else {
    // Fenced native bindings: the SAME workflow turns, wrapped in the
    // host-side activation lease (claim/renew/release). The kernel's
    // epoch-gated bind + session lease state provide zombie protection.
    try {
      outcome = yield* journal.withAuthority(function* (rootAuthority) {
        return yield* runFencedActivation(
          rootAuthority,
          params.conversationId,
          attach.executionEpoch,
          true,
          function* (claimedEpoch, activationOwnerId) {
            return yield* execution.driveTreeAtEpoch(claimedEpoch, activationOwnerId);
          },
        );
      });
    } catch (error) {
      if (
        !(yield* journal.withAuthority((authority) =>
          isExpectedCancellationFenceLoss(authority, params.conversationId, taskId, error),
        ))
      ) {
        throw error;
      }
      // A concurrent explicit stop owns journal terminalization. This activation
      // still owes its response consumer a valid terminal AG-UI outcome and must
      // help publish the idempotent authority capsule before returning.
      cancellationFenceLost = true;
      outcome = { state: "cancelled" };
    }
  }
  const after = yield* journal.readJournal(params.conversationId, taskId);
  return {
    before,
    after,
    outcome,
    liveMessageIds: execution.liveMessageIds,
    endedLiveMessageIds: execution.endedLiveMessageIds,
    cancellationFenceLost,
    replacementQueued,
  };
}

let activationOwnerCounter = 0;

function* isExpectedCancellationFenceLoss(
  authority: JournalAuthorityContract,
  sessionId: string,
  taskId: string,
  error: unknown,
): Operation<boolean> {
  if (
    !(error instanceof CrankError) ||
    !["stale_program_capability", "stale_activation", "unknown_target", "task_terminal"].includes(
      error.code,
    )
  ) {
    return false;
  }
  try {
    return (
      (yield* authority.query({ type: "task.cancellation-state", sessionId, taskId })).type !==
      "none"
    );
  } catch {
    return false;
  }
}

/** Fences only deployments whose native bindings declare fenced activation. */
function* runFencedActivation(
  authority: JournalAuthorityContract,
  sessionId: string,
  fallbackEpoch: number,
  fenced: boolean,
  activate: (epoch: number, ownerId?: string) => Operation<AdvancementResult>,
): Operation<AdvancementResult> {
  if (!fenced) {
    return yield* activate(fallbackEpoch);
  }
  activationOwnerCounter += 1;
  const ownerId = stableTupleHash([
    "host-activation",
    process.pid,
    Date.now(),
    activationOwnerCounter,
  ]);
  return yield* runWithRenewedActivationLease(
    authority,
    sessionId,
    ownerId,
    (epoch, currentOwnerId) => activate(epoch, currentOwnerId),
  );
}
