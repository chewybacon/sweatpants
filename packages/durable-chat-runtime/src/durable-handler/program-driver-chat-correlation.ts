import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import type { Json } from "@sweatpants/foundation";
import { jsonRecord } from "./program-driver-chat-projection-values.ts";

export type PullRequestedPayload = Extract<
  DurableSemanticRecord["payload"],
  { type: "PullRequested" }
>;
export type PendingElicit = Omit<PullRequestedPayload, "descriptor"> & {
  descriptor: Extract<PullRequestedPayload["descriptor"], { kind: "elicit" }>;
};

export function pendingCorrelation(
  records: DurableSemanticRecord[],
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
  // the immediately preceding root `tool_started` emission.
  const opened = records.find(
    (record) => record.payload.type === "TaskOpened" && record.payload.taskId === pending.taskId,
  );
  if (opened?.payload.type !== "TaskOpened" || !opened.payload.parentPullId) {
    return { elicitId: pending.pullId };
  }
  const parentPullId = opened.payload.parentPullId;
  const parentPullIndex = records.findIndex(
    (record) => record.payload.type === "PullRequested" && record.payload.pullId === parentPullId,
  );
  const parentTaskId = opened.payload.parentTaskId;
  for (let index = parentPullIndex - 1; index >= 0; index -= 1) {
    const candidate = records[index]?.payload;
    if (
      candidate?.type !== "DurableEmission" ||
      candidate.taskId !== parentTaskId ||
      candidate.descriptor.eventType !== "tool_started"
    ) {
      continue;
    }
    const payload = jsonRecord(candidate.descriptor.payload);
    if (typeof payload?.["callId"] === "string" && typeof payload["tool"] === "string") {
      return {
        callId: payload["callId"],
        elicitId: pending.pullId,
        toolName: payload["tool"],
      };
    }
  }
  return { elicitId: pending.pullId };
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
