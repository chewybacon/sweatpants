import { publicSubagentRunId } from "./program-driver-chat-attribution.ts";
import { EventType } from "@ag-ui/core";
import { CrankError } from "@sweatpants/durable-execution";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import { assertJson, stableTupleHash, type Json } from "@sweatpants/foundation";
import {
  type ActivityDeltaEvent,
  type ActivitySnapshotEvent,
  type PublicActivityNode,
  type PublicGenericActivityNode,
} from "@sweatpants/chat-core";
import type { StreamEvent } from "./program-driver-chat-types.ts";
import {
  jsonRecord,
  placementFromJson,
  portableDescriptorFromJson,
  type TreePlacement,
} from "./program-driver-chat-projection-codecs.ts";

type RecursiveExecutionNode = {
  readonly type: "execution";
  readonly placement: TreePlacement;
  readonly executionId: string;
  readonly presentation: "public" | "opaque";
  readonly status: "running" | "complete" | "error" | "cancelled";
  readonly children: readonly never[];
};

import {
  parentToolStart,
  type ChatJournalIndex,
  type PendingElicit,
} from "./program-driver-chat-journal-index.ts";
import { requiredPendingCorrelation } from "./program-driver-chat-correlation.ts";

function publicActivitySnapshot(
  messageId: string,
  node: PublicActivityNode,
): ActivitySnapshotEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId,
    activityType: "sweatpants:public-execution",
    replace: true,
    content: { version: 1, node: assertJson(node) },
  };
}

export function publicElicitActivityDelta(
  nodeId: string,
  state: "responded" | "cancelled",
): ActivityDeltaEvent {
  return {
    type: EventType.ACTIVITY_DELTA,
    messageId: nodeId,
    activityType: "sweatpants:public-execution",
    patch: [{ op: "replace", path: "/node/state", value: state }],
  };
}

/** A synthetic tool-only message owns exactly one call, including its terminal outcome. */
export function publicToolMessageCompleted(messageId: string): ActivityDeltaEvent {
  return {
    type: EventType.ACTIVITY_DELTA,
    messageId,
    activityType: "sweatpants:public-execution",
    patch: [{ op: "replace", path: "/node/state", value: "done" }],
  };
}

function executionState(
  status: RecursiveExecutionNode["status"],
): PublicGenericActivityNode["state"] {
  return status === "complete"
    ? "complete"
    : status === "error"
      ? "error"
      : status === "cancelled"
        ? "cancelled"
        : "running";
}

function opaqueExecutionActivity(node: RecursiveExecutionNode): ActivitySnapshotEvent {
  return publicActivitySnapshot(node.placement.nodeId, {
    nodeId: node.placement.nodeId,
    parentNodeId: node.placement.parentNodeId,
    sequence: node.placement.sequence,
    kind: "activity",
    state: executionState(node.status),
    presentation: "opaque",
    publicData: { kind: "activity", activityType: "opaque-execution" },
  });
}

export function publicActivityToolStartSnapshots(
  index: ChatJournalIndex,
  record: DurableSemanticRecord,
  payload: Record<string, Json>,
): ActivitySnapshotEvent[] {
  const callId = String(payload["callId"]);
  const toolName = String(payload["tool"]);
  const parentNodeId = parentExecutionNodeId(index, record);
  const messageId = `message:${record.payload.type === "DurableEmission" ? record.payload.taskId : "unknown"}:${callId}`;
  const executionId = `execution:${callId}`;
  return [
    publicActivitySnapshot(messageId, {
      nodeId: messageId,
      parentNodeId,
      sequence: record.payload.type === "DurableEmission" ? record.payload.emissionIndex : 0,
      kind: "message",
      state: "streaming",
      presentation: "public",
      publicData: { kind: "message", messageId, role: "assistant" },
    }),
    publicActivitySnapshot(executionId, {
      nodeId: executionId,
      parentNodeId: messageId,
      sequence: 0,
      kind: "tool-call",
      state: "input-available",
      presentation: "public",
      publicData: {
        kind: "tool-call",
        callId,
        name: toolName,
        input: payload["input"] ?? null,
        rawInput: JSON.stringify(payload["input"] ?? null),
      },
    }),
  ];
}

export function publicActivityElicitSnapshots(
  index: ChatJournalIndex,
  pending: PendingElicit,
  interrupt: Extract<StreamEvent, { type: EventType.RUN_FINISHED }>,
): ActivitySnapshotEvent[] {
  if (interrupt.outcome?.type !== "interrupt") {
    return [];
  }
  const value = interrupt.outcome.interrupts[0];
  const metadata = value?.metadata ?? {};
  const facts = jsonRecord(metadata["sweatpants/elicitation"]);
  const bindingId = typeof facts?.["bindingId"] === "string" ? facts["bindingId"] : undefined;
  const responseContract = portableDescriptorFromJson(facts?.["responseContract"]);
  const contextContract = portableDescriptorFromJson(facts?.["contextContract"]);
  const placement = placementFromJson(facts?.["placement"]);
  if (!value || !bindingId || !responseContract || !placement) {
    return [];
  }
  const snapshots: ActivitySnapshotEvent[] = [];
  if (placement.parentNodeId === stableTupleHash(["execution-opaque", pending.taskId])) {
    const opaqueNodes = opaqueAncestryForTask(index, pending.taskId, placement.sequence);
    const first = opaqueNodes[0];
    if (!first) {
      throw new CrankError(
        "client_activity_parent_missing",
        "Unable to derive opaque execution ancestry",
      );
    }
    if (first.placement.parentNodeId === null) {
      const rootMessageId = `${first.placement.nodeId}:root`;
      snapshots.push(
        publicActivitySnapshot(rootMessageId, {
          nodeId: rootMessageId,
          parentNodeId: null,
          sequence: placement.sequence,
          kind: "message",
          state: "streaming",
          presentation: "public",
          publicData: { kind: "message", messageId: rootMessageId, role: "assistant" },
        }),
      );
      const rootToolId = `private-tool:${first.placement.nodeId}`;
      snapshots.push(
        publicActivitySnapshot(rootToolId, {
          nodeId: rootToolId,
          parentNodeId: rootMessageId,
          sequence: 0,
          kind: "tool-call",
          state: "input-available",
          presentation: "public",
          publicData: {
            kind: "tool-call",
            callId: first.placement.nodeId,
            name: "private-execution",
            input: null,
          },
        }),
      );
      snapshots.push(
        opaqueExecutionActivity({
          ...first,
          placement: { ...first.placement, parentNodeId: rootToolId, sequence: 0 },
        }),
      );
      for (const node of opaqueNodes.slice(1)) {
        snapshots.push(opaqueExecutionActivity(node));
      }
    } else {
      snapshots.push(...opaqueNodes.map(opaqueExecutionActivity));
    }
  }
  const key =
    typeof metadata["sweatpants/key"] === "string"
      ? metadata["sweatpants/key"]
      : pending.descriptor.key;
  const { callId, toolName } = requiredPendingCorrelation(index, pending);
  const nodeId = placement.nodeId;
  snapshots.push(
    publicActivitySnapshot(nodeId, {
      nodeId,
      parentNodeId: placement.parentNodeId,
      sequence: placement.sequence,
      kind: "elicit",
      state: "pending",
      presentation: "public",
      publicData: {
        kind: "elicit",
        elicitId: value.id,
        bindingId,
        key,
        message: value.message ?? "Input required",
        ...(facts?.["context"] !== undefined ? { context: facts["context"] } : {}),
        responseContract,
        ...(contextContract !== undefined ? { contextContract } : {}),
        toolName,
        callId,
        producerSequence: placement.sequence,
      },
    }),
  );
  const subagentRunId = publicSubagentRunId(index, pending.taskId);
  return subagentRunId === undefined
    ? snapshots
    : snapshots.map((event) =>
        event.messageId === `elicit:${pending.pullId}` ? { ...event, subagentRunId } : event,
      );
}

function parentExecutionNodeId(
  index: ChatJournalIndex,
  record: DurableSemanticRecord,
): string | null {
  if (record.payload.type !== "DurableEmission") {
    return null;
  }
  return parentExecutionNodeIdForTask(index, record.payload.taskId);
}

function parentExecutionNodeIdForTask(index: ChatJournalIndex, taskId: string): string | null {
  const parent = parentToolStart(index, taskId);
  return parent ? `execution:${parent.callId}` : null;
}

function opaqueAncestryForTask(
  index: ChatJournalIndex,
  taskId: string,
  leafSequence: number,
  leafTaskId = taskId,
): RecursiveExecutionNode[] {
  const openedPayload = index.tasks.get(taskId);
  const publicParent = parentExecutionNodeIdForTask(index, taskId);
  const parentNodes =
    publicParent ||
    !openedPayload ||
    openedPayload.type !== "TaskOpened" ||
    !openedPayload.parentTaskId
      ? []
      : opaqueAncestryForTask(index, openedPayload.parentTaskId, 0, leafTaskId);
  const parentNodeId = publicParent ?? parentNodes.at(-1)?.placement.nodeId ?? null;
  const nodeId = stableTupleHash(["execution-opaque", taskId]);
  const node: RecursiveExecutionNode = {
    type: "execution",
    placement: {
      nodeId,
      parentNodeId,
      sequence: taskId === leafTaskId ? leafSequence : 0,
    },
    executionId: nodeId,
    presentation: "opaque",
    status: "running",
    children: [],
  };
  return [...parentNodes, node];
}
