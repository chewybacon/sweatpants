import { CrankError } from "@sweatpants/durable-execution";
import {
  parentToolStart,
  type ChatJournalIndex,
  type PendingElicit,
} from "./program-driver-chat-journal-index.ts";
import { elicitationContextEvidence } from "./program-driver-chat-projection-codecs.ts";

export type PendingCorrelation = {
  readonly callId?: string;
  readonly elicitId?: string;
  readonly toolName?: string;
};

export function pendingCorrelation(
  index: ChatJournalIndex,
  pending: PendingElicit,
): PendingCorrelation {
  const evidence = elicitationContextEvidence(pending.descriptor.context, pending.descriptor.key);
  if (evidence.callId || evidence.toolName) {
    return {
      /* CONDITIONAL-SPREAD: Omit absent callId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(evidence.callId ? { callId: evidence.callId } : {}),
      /* CONDITIONAL-SPREAD: Omit absent elicitId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(evidence.elicitId ? { elicitId: evidence.elicitId } : {}),
      /* CONDITIONAL-SPREAD: Omit absent toolName from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(evidence.toolName ? { toolName: evidence.toolName } : {}),
    };
  }

  // Native durable child context is the authored value only. Correlation stays
  // private by deriving the child invocation from TaskOpened.parentPullId and
  // the tool start immediately preceding that pull.
  const parent = parentToolStart(index, pending.taskId);
  return parent
    ? { callId: parent.callId, elicitId: pending.pullId, toolName: parent.tool }
    : { elicitId: pending.pullId };
}

export function requiredPendingCorrelation(
  index: ChatJournalIndex,
  pending: PendingElicit,
): { readonly callId: string; readonly toolName: string; readonly elicitId?: string } {
  const correlation = pendingCorrelation(index, pending);
  if (correlation.callId === undefined || correlation.toolName === undefined) {
    throw new CrankError(
      "interaction_binding_missing",
      `Elicitation "${pending.descriptor.key}" has no authored tool correlation`,
    );
  }
  return {
    callId: correlation.callId,
    toolName: correlation.toolName,
    /* CONDITIONAL-SPREAD: Omit absent elicitId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
    ...(correlation.elicitId === undefined ? {} : { elicitId: correlation.elicitId }),
  };
}
