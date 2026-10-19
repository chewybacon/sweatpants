import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ElicitExchangeCompletion } from "@sweatpants/agent-sdk";
import type { Operation } from "effection";
import { CrankError } from "@sweatpants/durable-execution";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import { assertJson, type Json } from "@sweatpants/foundation";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { ToolInvocationHostPort } from "@sweatpants/tool-session";
import {
  EPHEMERAL_TOOL_ADAPTER_PROGRAM,
  ephemeralToolInvocationId,
} from "@sweatpants/tool-session/ephemeral";

import type { ProgramDriverJournal } from "../program-driver-journal.ts";
import type { ElicitResponse } from "../types.ts";
import type { ProgramDriverNativeToolComposition } from "../../program-driver/native-tools.ts";
import { pendingCorrelation } from "./program-driver-chat-correlation.ts";
import {
  indexChatJournal,
  type ChatJournalIndex,
  type PendingElicit,
} from "./program-driver-chat-journal-index.ts";

export function* disposeEphemeralChildSessions(
  records: readonly DurableSemanticRecord[],
  sessionId: string,
): Operation<void> {
  const closed = new Set(
    records.flatMap((record) =>
      record.payload.type === "TaskClosed" ? [record.payload.taskId] : [],
    ),
  );
  const taskIds = records.flatMap((record) =>
    record.payload.type === "TaskOpened" &&
    record.payload.programId === EPHEMERAL_TOOL_ADAPTER_PROGRAM.id &&
    !closed.has(record.payload.taskId)
      ? [record.payload.taskId]
      : [],
  );
  if (taskIds.length === 0) {
    return;
  }
  const host = yield* ToolInvocationHostPort.use();
  for (const taskId of taskIds) {
    yield* host.dispose(ephemeralToolInvocationId(sessionId, taskId));
  }
}

export function* cancelPendingElicits(
  journal: ProgramDriverJournal,
  records: DurableSemanticRecord[],
  sessionId: string,
  participantId: string,
): Operation<void> {
  const resolved = new Set(
    records.flatMap((entry) =>
      entry.payload.type === "PullResolved" ? [entry.payload.pullId] : [],
    ),
  );
  for (const entry of records) {
    const payload = entry.payload;
    if (
      payload.type !== "PullRequested" ||
      payload.descriptor.kind !== "elicit" ||
      resolved.has(payload.pullId)
    ) {
      continue;
    }
    const result = yield* journal.resolvePending({
      sessionId,
      taskId: payload.taskId,
      pullId: payload.pullId,
      audience: participantId,
      outcome: { status: "cancelled" },
    });
    if (
      result.status === "rejected" &&
      result.code !== "capability_revoked" &&
      result.code !== "task_terminal"
    ) {
      throw new CrankError(result.code, "Pending cancellation was rejected");
    }
  }
}

export interface ElicitSettlementRequest {
  readonly responses: readonly ElicitResponse[];
  readonly sessionId: string;
  readonly participantId: string;
  readonly nativeBindings?: ProgramDriverNativeToolComposition["bindings"];
}

function nativeElicitResponseSchema(
  request: ElicitSettlementRequest,
  index: ChatJournalIndex,
  pending: PendingElicit,
) {
  const openedPayload = index.tasks.get(pending.taskId);
  if (!openedPayload) {
    return undefined;
  }
  const binding = [...(request.nativeBindings?.values() ?? [])].find(
    (candidate) => candidate.tool.manifest.digest === openedPayload.programDigest,
  );
  return binding?.tool.elicits[pending.descriptor.key]?.response;
}

/**
 * Native durable programs carry only portable descriptor evidence through the
 * journal. The installed authored contract remains the host command-lane
 * validation authority, so transformed response output is produced here
 * before the value is accepted by the durable program.
 */
export function normalizeElicitCompletion(
  completion: ElicitResponse["completion"],
  schema: StandardSchemaV1 | undefined,
  key: string,
): ElicitExchangeCompletion<Json> {
  if (completion.action !== "accept") {
    return completion;
  }
  const parsed = schema ? validateAuthoredSchema(schema, completion.content) : undefined;
  if (parsed && parsed.status !== "ok") {
    throw new CrankError(
      "elicit_response_invalid",
      `Elicitation response validation failed for key "${key}"`,
    );
  }
  try {
    return { action: "accept", content: assertJson(parsed ? parsed.value : completion.content) };
  } catch (error) {
    throw new CrankError(
      "elicit_response_invalid",
      `Elicitation response for key "${key}" is not JSON-serializable`,
      undefined,
      { cause: error },
    );
  }
}

export function* resolveElicitResponses(
  request: ElicitSettlementRequest,
  journal: ProgramDriverJournal,
  records: DurableSemanticRecord[],
): Operation<number> {
  let accepted = 0;
  const index = indexChatJournal(records);
  for (const response of request.responses) {
    const pending = findPendingResponse(index, response);
    if (!pending) {
      continue;
    }
    const completion = normalizeElicitCompletion(
      response.completion,
      nativeElicitResponseSchema(request, index, pending),
      pending.descriptor.key,
    );
    const result = yield* journal.resolvePending({
      sessionId: request.sessionId,
      taskId: pending.taskId,
      pullId: pending.pullId,
      audience: request.participantId,
      outcome: { status: "ok", value: completion },
    });
    if (result.status === "accepted" || result.status === "duplicate") {
      accepted += 1;
    }
  }
  return accepted;
}

function findPendingResponse(
  index: ChatJournalIndex,
  response: ElicitResponse,
): PendingElicit | undefined {
  const requests = [...index.pullRequests.values()];
  for (let cursor = requests.length - 1; cursor >= 0; cursor -= 1) {
    const payload = requests[cursor];
    if (payload?.descriptor.kind !== "elicit" || index.resolvedPullIds.has(payload.pullId)) {
      continue;
    }
    const correlation = pendingCorrelation(index, {
      ...payload,
      descriptor: payload.descriptor,
    });
    const effectiveCallId = correlation.callId ?? payload.pullId;
    if (
      (response.callId === undefined || effectiveCallId === response.callId) &&
      (correlation.elicitId === response.elicitId || payload.pullId === response.elicitId)
    ) {
      return { ...payload, descriptor: payload.descriptor };
    }
  }
  return undefined;
}
