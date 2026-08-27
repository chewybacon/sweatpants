import {
  parentToolStart,
  type ChatJournalIndex,
  type PendingElicit,
} from "./program-driver-chat-journal-index.ts";
import { elicitationContextEvidence } from "./program-driver-chat-projection-codecs.ts";

export function pendingCorrelation(
  index: ChatJournalIndex,
  pending: PendingElicit,
): { callId?: string; elicitId?: string; toolName?: string } {
  const evidence = elicitationContextEvidence(pending.descriptor.context, pending.descriptor.key);
  if (evidence.callId || evidence.toolName) {
    return {
      ...(evidence.callId ? { callId: evidence.callId } : {}),
      ...(evidence.elicitId ? { elicitId: evidence.elicitId } : {}),
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
