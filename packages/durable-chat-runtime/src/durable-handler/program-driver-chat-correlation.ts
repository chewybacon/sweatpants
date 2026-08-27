import type { Json } from "@sweatpants/foundation";
import {
  parentToolStart,
  type ChatJournalIndex,
  type PendingElicit,
} from "./program-driver-chat-journal-index.ts";
import { jsonRecord } from "./program-driver-chat-projection-codecs.ts";

export function pendingCorrelation(
  index: ChatJournalIndex,
  pending: PendingElicit,
): { callId?: string; elicitId?: string; toolName?: string } {
  const context = jsonRecord(pending.descriptor.context);
  const nested = jsonRecord(context?.["context"]);
  const legacyForeignId = legacyForeignCallId(context, nested);
  const legacyForeignTool =
    typeof context?.["foreignTool"] === "string"
      ? context["foreignTool"]
      : typeof nested?.["toolName"] === "string"
        ? nested["toolName"]
        : undefined;
  if (legacyForeignId || legacyForeignTool) {
    const elicitId = legacyForeignElicitId(context, nested);
    return {
      ...(legacyForeignId ? { callId: legacyForeignId } : {}),
      ...(elicitId ? { elicitId } : {}),
      ...(legacyForeignTool ? { toolName: legacyForeignTool } : {}),
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

function legacyForeignCallId(
  context: Record<string, Json> | undefined,
  nested: Record<string, Json> | undefined,
): string | undefined {
  if (typeof context?.["foreignRoute"] === "string") {
    return context["foreignRoute"];
  }
  return typeof nested?.["callId"] === "string" ? nested["callId"] : undefined;
}

function legacyForeignElicitId(
  context: Record<string, Json> | undefined,
  nested: Record<string, Json> | undefined,
): string | undefined {
  if (typeof nested?.["elicitId"] === "string") {
    return nested["elicitId"];
  }
  return typeof context?.["foreignKey"] === "string" ? context["foreignKey"] : undefined;
}
