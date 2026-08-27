import { type Operation } from "effection";
import { CrankError } from "@sweatpants/durable-execution";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import { assertJson } from "@sweatpants/foundation";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { ToolInvocationHostPort } from "@sweatpants/tool-session";
import {
  FOREIGN_TOOL_ADAPTER_PROGRAM,
  foreignToolInvocationId,
} from "@sweatpants/tool-session/foreign";

import type { ProgramDriverJournal } from "./program-driver-journal.ts";
import type { ElicitResponse } from "./types.ts";
import type { ProgramDriverChatEngineParams } from "./program-driver-chat-types.ts";
import { pendingCorrelation, type PendingElicit } from "./program-driver-chat-correlation.ts";

export function* disposeForeignChildSessions(
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
    record.payload.programId === FOREIGN_TOOL_ADAPTER_PROGRAM.id &&
    !closed.has(record.payload.taskId)
      ? [record.payload.taskId]
      : [],
  );
  if (taskIds.length === 0) {
    return;
  }
  const host = yield* ToolInvocationHostPort.use();
  for (const taskId of taskIds) {
    yield* host.dispose(foreignToolInvocationId(sessionId, taskId));
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

function nativeElicitResponseSchema(
  params: ProgramDriverChatEngineParams,
  records: DurableSemanticRecord[],
  pending: PendingElicit,
) {
  const opened = records.find(
    (record) => record.payload.type === "TaskOpened" && record.payload.taskId === pending.taskId,
  );
  const openedPayload = opened?.payload;
  if (!openedPayload || openedPayload.type !== "TaskOpened") {
    return undefined;
  }
  const binding = [...(params.nativeTools?.bindings.values() ?? [])].find(
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
function* normalizeNativeElicitCompletion(
  params: ProgramDriverChatEngineParams,
  records: DurableSemanticRecord[],
  pending: PendingElicit,
  completion: ElicitResponse["completion"],
): Operation<ElicitResponse["completion"]> {
  if (completion.action !== "accept") {
    return completion;
  }
  const schema = nativeElicitResponseSchema(params, records, pending);
  if (!schema) {
    return completion;
  }
  const parsed = validateAuthoredSchema(schema, completion.content);
  if (parsed.status !== "ok") {
    throw new CrankError(
      "elicit_response_invalid",
      `Elicitation response validation failed for key "${pending.descriptor.key}"`,
    );
  }
  try {
    return { action: "accept", content: assertJson(parsed.value) };
  } catch (error) {
    throw new CrankError(
      "elicit_response_invalid",
      `Elicitation response for key "${pending.descriptor.key}" is not JSON-serializable`,
      undefined,
      { cause: error },
    );
  }
}

export function* resolveElicitResponses(
  params: ProgramDriverChatEngineParams,
  journal: ProgramDriverJournal,
  records: DurableSemanticRecord[],
): Operation<number> {
  let accepted = 0;
  for (const response of params.elicitResponses ?? []) {
    const pending = findPendingResponse(records, response);
    if (!pending) {
      continue;
    }
    const completion = yield* normalizeNativeElicitCompletion(
      params,
      records,
      pending,
      response.completion,
    );
    const result = yield* journal.resolvePending({
      sessionId: params.conversationId,
      taskId: pending.taskId,
      pullId: pending.pullId,
      audience: params.participantId,
      outcome: { status: "ok", value: assertJson(completion) },
    });
    if (result.status === "accepted" || result.status === "duplicate") {
      accepted += 1;
    }
  }
  return accepted;
}

function findPendingResponse(
  records: DurableSemanticRecord[],
  response: ElicitResponse,
): PendingElicit | undefined {
  const resolved = new Set(
    records.flatMap((record) =>
      record.payload.type === "PullResolved" ? [record.payload.pullId] : [],
    ),
  );
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = records[index]?.payload;
    if (
      payload?.type !== "PullRequested" ||
      payload.descriptor.kind !== "elicit" ||
      resolved.has(payload.pullId)
    ) {
      continue;
    }
    const correlation = pendingCorrelation(records, {
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
