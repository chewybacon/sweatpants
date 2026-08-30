import { stableTupleHash } from "@sweatpants/foundation";

import type {
  AuthorityCommand,
  AuthorityDecisionFrame,
  AuthorityState,
  PullState,
  TaskState,
} from "../contract/authority-contract.ts";
import { signCapability } from "../contract/capabilities.ts";
import { pullAudience, taskOriginSession } from "./decision-state.ts";

interface ResolutionCapabilitySigningRequest {
  readonly context: AuthorityDecisionFrame<AuthorityCommand>["context"];
  readonly state: AuthorityState;
  readonly task: TaskState;
  readonly pull: PullState;
  readonly attemptId?: string;
  readonly nonce: string;
}

/** Signs one complete resolution authority fact without command or draft authority. */
export function signResolutionCapability(request: ResolutionCapabilitySigningRequest): string {
  const { context, state, task, pull } = request;
  return signCapability(
    {
      journalId: context.journalIdentity.id,
      journalIncarnation: context.journalIdentity.incarnation,
      sessionId: taskOriginSession(state, task.taskId),
      taskId: task.taskId,
      pullId: pull.pullId,
      descriptorDigest: pull.request.proposedDescriptorDigest,
      resultSchemaDigest: pull.request.resultSchemaDigest,
      attemptId: request.attemptId ?? "none",
      audience: pullAudience(pull),
      permissions: ["resolve"],
      maxOutcomeBytes: pull.request.maxOutcomeBytes,
      nonce: request.nonce,
    },
    context.keyring,
  );
}

/** Reproduces the next transaction nonce without mutating a read-only snapshot. */
export function nextResolutionQueryNonce(
  context: AuthorityDecisionFrame<AuthorityCommand>["context"],
  state: AuthorityState,
): string {
  return stableTupleHash(["nonce", context.journalIdentity.id, state.nextNonce + 1]);
}
