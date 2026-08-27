import { EventType } from "@ag-ui/core";
import { CrankError } from "@sweatpants/durable-execution";
import { stableTupleHash, type Json, type JsonObject } from "@sweatpants/foundation";
import { parseInteractionBinding } from "@sweatpants/agent-sdk";
import type { StreamEvent } from "./program-driver-chat-types.ts";
import type { AgUiRunMetadata } from "@sweatpants/chat-core";
import type { ToolInventoryEntry } from "@sweatpants/tool-runtime";
import { pendingCorrelation } from "./program-driver-chat-correlation.ts";
import {
  pendingElicit,
  type ChatJournalIndex,
  type PendingElicit,
} from "./program-driver-chat-journal-index.ts";
import { elicitationContextEvidence, jsonRecord } from "./program-driver-chat-projection-codecs.ts";

export function pendingToolCallId(index: ChatJournalIndex, pending: PendingElicit): string {
  return pendingCorrelation(index, pending).callId ?? pending.pullId;
}

export interface InterruptProjectionPolicy {
  readonly agUiRun: AgUiRunMetadata;
  readonly toolInventory: readonly ToolInventoryEntry[];
}

export function projectInterrupt(
  index: ChatJournalIndex,
  pending: NonNullable<ReturnType<typeof pendingElicit>>,
  policy: InterruptProjectionPolicy,
): Extract<StreamEvent, { type: EventType.RUN_FINISHED }> {
  const context = elicitationContextEvidence(pending.descriptor.context, pending.descriptor.key);
  const correlation = pendingCorrelation(index, pending);
  const authoredContext = context.authoredContext;
  const responseProjection = context.historical
    ? context.responseProjection
    : pending.descriptor.response.inputProjection;
  const encoded = {
    message: pending.descriptor.message,
    schema: objectSchema(responseProjection),
  };
  const publicKey = context.publicKey;
  const inventoryElicit = policy.toolInventory.find(
    (entry) => entry.definition.name === correlation.toolName,
  )?.elicits?.[publicKey];
  if (!inventoryElicit) {
    throw new CrankError(
      "interaction_binding_missing",
      `No authored interaction contract exists for elicitation "${publicKey}"`,
    );
  }
  const { responseContract, contextContract } = inventoryElicit;
  const binding = bindingForPending(pending);
  const placement = placementForPending(index, pending, correlation);
  return {
    type: EventType.RUN_FINISHED,
    ...policy.agUiRun,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: pending.pullId,
          reason: "input_required",
          message: encoded.message,
          responseSchema: encoded.schema,
          toolCallId: correlation.callId ?? pending.pullId,
          metadata: {
            "sweatpants/key": publicKey,
            ...(correlation.toolName ? { "sweatpants/toolName": correlation.toolName } : {}),
            callId: correlation.callId ?? pending.pullId,
            ...(correlation.elicitId ? { elicitId: correlation.elicitId } : {}),
            "sweatpants/elicitation": {
              bindingId: binding.id,
              ...(authoredContext !== undefined ? { context: authoredContext } : {}),
              responseContract,
              ...(contextContract ? { contextContract } : {}),
              placement,
            },
          },
        },
      ],
    },
  };
}

function bindingForPending(pending: PendingElicit) {
  if (!pending.descriptor.binding) {
    throw new CrankError(
      "interaction_binding_missing",
      `Elicitation "${pending.descriptor.key}" parked without an authored binding`,
    );
  }
  try {
    return parseInteractionBinding(pending.descriptor.binding);
  } catch (error) {
    throw new CrankError(
      "interaction_binding_missing",
      `Persisted binding is invalid for elicitation "${pending.descriptor.key}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function placementForPending(
  index: ChatJournalIndex,
  pending: PendingElicit,
  correlation: { callId?: string },
): { nodeId: string; parentNodeId: string | null; sequence: number } {
  const callId = correlation.callId;
  const publicExecution = callId ? index.publicToolCallIds.has(callId) : false;
  const parentNodeId =
    callId && publicExecution
      ? `execution:${callId}`
      : stableTupleHash(["execution-opaque", pending.taskId]);
  const sequence = pending.pullIndex;
  return {
    nodeId: `elicit:${pending.pullId}`,
    parentNodeId,
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
  };
}

function objectSchema(value: Json | undefined): JsonObject {
  return jsonRecord(value) ?? {};
}
