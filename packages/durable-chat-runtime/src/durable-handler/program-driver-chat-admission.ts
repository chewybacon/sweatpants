import { type Operation } from "effection";
import {
  CrankError,
  assertReplayedCanonicalValue,
  stableProgramAttachmentId,
  type AttachProgramRequest,
} from "@sweatpants/durable-execution";
import { canonicalJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";

import { nativeProgramIdentities } from "../program-driver/native-tools.ts";
import type { ProgramDriverJournal } from "./program-driver-journal.ts";
import {
  manifest,
  type ChatProgramInput,
  type ChatToolCatalog,
  type ChatToolCatalogEntry,
} from "./program-driver-schema.ts";
import type { ProgramDriverChatEngineParams } from "./program-driver-chat-types.ts";

type ActiveChatTurn = { readonly taskId: string; readonly turnId: string; readonly input: Json };

export interface ChatTurnAdmission {
  readonly journal: ProgramDriverJournal;
  readonly active?: ActiveChatTurn;
  readonly taskId: string;
  readonly before: import("@sweatpants/journal-authority").DurableSemanticRecord[];
  readonly input: ChatProgramInput;
  readonly attach: AttachProgramRequest;
  readonly replacementQueued: boolean;
}

export function* admitProgramDriverChatTurn(
  params: ProgramDriverChatEngineParams,
): Operation<ChatTurnAdmission> {
  const journal = yield* params.journalStore.open(params.conversationId);
  const scopedForeignEffects = params.foreignEffects;
  const recovery = yield* journal.recoveryState(params.conversationId);
  const active =
    recovery.status === "active"
      ? { taskId: recovery.taskId, turnId: recovery.turnId, input: recovery.input }
      : undefined;
  const recoveredExecutionEpoch =
    recovery.status === "active"
      ? (recovery.activeTasks.find((task) => task.taskId === recovery.taskId)?.executionEpoch ?? 1)
      : 1;
  const turnNumber = yield* journal.rootTaskCount(params.conversationId);
  const taskId = active?.taskId ?? `turn-${turnNumber}/root`;
  const turnId = active?.turnId ?? `turn-${turnNumber}`;
  let before = yield* journal.readJournal(params.conversationId, taskId);
  const foreignDriver = scopedForeignEffects ? "tool-session" : "chat-tool-runtime";
  if (!params.modelContextSource) {
    throw new CrankError(
      "model_context_source_invalid",
      "Chat-root execution requires an authoritative conversation context source",
    );
  }
  const modelContextSource = {
    ...params.modelContextSource,
    taskId,
  };
  const requestedInput: ChatProgramInput = {
    contextSource: modelContextSource,
    maxIterations: params.maxIterations,
    catalog: createChatToolCatalog(params, foreignDriver),
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.initialToolChoice !== undefined ? { toolChoice: params.initialToolChoice } : {}),
  };
  // Replay of the accepted canonical input never reruns schema code (DR-023).
  const replacementQueued =
    active !== undefined &&
    params.pluginAbort === undefined &&
    params.recoveryOnly !== true &&
    (params.elicitResponses?.length ?? 0) === 0 &&
    canonicalJson(active.input) !== canonicalJson(requestedInput);
  const input = active
    ? assertReplayedCanonicalValue<ChatProgramInput>(active.input)
    : requestedInput;
  const attach = {
    sessionId: params.conversationId,
    taskId,
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input,
    route: { driverKind: "program" },
    executionEpoch: recoveredExecutionEpoch,
    affinity: { kind: "conversation" as const, key: params.conversationId },
  };
  if (!active) {
    try {
      yield* journal.openTask({
        sessionId: params.conversationId,
        turnId,
        taskId,
        manifest,
        input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "workflow-host",
        elicitAudience: params.participantId,
      });
    } catch (error) {
      if (!(error instanceof CrankError) || error.code !== "invalid_journal") {
        throw error;
      }
      const raced = yield* journal.recoveryState(params.conversationId);
      if (
        raced.status !== "active" ||
        raced.taskId !== taskId ||
        canonicalJson(raced.input) !== canonicalJson(input)
      ) {
        throw new CrankError("idempotency_conflict", "Concurrent root task input differs");
      }
    }
    before = yield* journal.readJournal(params.conversationId, taskId);
  }
  params.onLiveTaskReady?.(taskId);
  return {
    journal,
    ...(active === undefined ? {} : { active }),
    taskId,
    before,
    input,
    attach,
    replacementQueued,
  };
}

function createChatToolCatalog(
  params: ProgramDriverChatEngineParams,
  foreignDriver: "tool-session" | "chat-tool-runtime",
): ChatToolCatalog {
  const nativePrograms = nativeProgramIdentities(params.nativeTools);
  const entries: Record<string, ChatToolCatalogEntry> = {};
  const sortedTools = [...params.toolSchemas].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const tool of sortedTools) {
    const program = nativePrograms[tool.name];
    entries[tool.name] = {
      model: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
      execution: program
        ? { kind: "program", target: tool.name, program }
        : {
            kind: "foreign-tool",
            target: tool.name,
            driver: foreignDriver,
            tool: tool.name,
            durability: "ephemeral_handle",
          },
    };
  }
  return {
    version: 1,
    digest: canonicalSnapshot({ version: 1, entries }).sha,
    entries,
  };
}
