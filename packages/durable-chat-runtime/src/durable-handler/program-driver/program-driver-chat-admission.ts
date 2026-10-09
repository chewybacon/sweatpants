import { type Operation } from "effection";
import {
  CrankError,
  assertReplayedCanonicalValue,
  rootTurnIdentity,
  stableProgramAttachmentId,
  type AttachProgramRequest,
  type PinnedProgram,
} from "@sweatpants/durable-execution";
import { canonicalJson, type Json, canonicalDigest } from "@sweatpants/foundation";

import type { ProgramDriverJournal } from "../program-driver-journal.ts";
import {
  manifest,
  type ChatProgramInput,
  type ChatToolCatalog,
  type ChatToolCatalogEntry,
} from "../program-driver-schema.ts";
import type { ModelContextSource } from "@sweatpants/model-sampling";
import type { ProgramDriverJournalStore } from "../program-driver-journal.ts";
import type { ToolSchema } from "../types.ts";
import type { StreamOptions } from "@sweatpants/model-provider";

type ActiveChatTurn = { readonly taskId: string; readonly turnId: string; readonly input: Json };

export interface ChatAdmissionInputPolicy {
  readonly systemPrompt?: string;
  readonly initialToolChoice?: StreamOptions["toolChoice"];
}

export interface ChatAdmissionRequest {
  readonly journalStore: ProgramDriverJournalStore;
  readonly conversationId: string;
  readonly participantId: string;
  readonly contextSource: ModelContextSource;
  readonly maxIterations: number;
  readonly tools: readonly ToolSchema[];
  readonly nativePrograms: Readonly<Record<string, PinnedProgram>>;
  readonly ephemeral:
    | { readonly kind: "none" }
    | { readonly kind: "driver"; readonly driver: "tool-session" | "chat-tool-runtime" };
  readonly inputPolicy: ChatAdmissionInputPolicy;
  readonly recoveryOnly: boolean;
  readonly superseding: boolean;
  readonly hasElicitResponses: boolean;
  readonly onTaskReady?: (taskId: string) => void;
}

export type ChatTurnTransition = { readonly kind: "continue" } | { readonly kind: "supersede" };

export interface ChatTurnAdmission {
  readonly journal: ProgramDriverJournal;
  readonly active?: ActiveChatTurn;
  readonly taskId: string;
  readonly before: import("@sweatpants/journal-authority").DurableSemanticRecord[];
  readonly input: ChatProgramInput;
  readonly attach: AttachProgramRequest;
  readonly transition: ChatTurnTransition;
}

export function* admitProgramDriverChatTurn(
  request: ChatAdmissionRequest,
  journal: ProgramDriverJournal,
): Operation<ChatTurnAdmission> {
  const recovery = yield* journal.recoveryState(request.conversationId);
  const active =
    recovery.status === "active"
      ? { taskId: recovery.taskId, turnId: recovery.turnId, input: recovery.input }
      : undefined;
  let recoveredExecutionEpoch = 1;
  if (recovery.status === "active") {
    const recoveredRoot = recovery.activeTasks.find((task) => task.taskId === recovery.taskId);
    if (recoveredRoot === undefined) {
      throw new CrankError("invalid_journal", "Active recovery omitted its root task");
    }
    recoveredExecutionEpoch = recoveredRoot.executionEpoch;
  }
  const turnIdentity = active
    ? { turnId: active.turnId, taskId: active.taskId }
    : rootTurnIdentity(yield* journal.rootTaskCount(request.conversationId));
  const { taskId, turnId } = turnIdentity;
  let before = yield* journal.readJournal(request.conversationId, taskId);
  const modelContextSource = {
    ...request.contextSource,
    taskId,
  };
  const requestedInput: ChatProgramInput = {
    contextSource: modelContextSource,
    maxIterations: request.maxIterations,
    catalog: createChatToolCatalog(request),
    ...(request.inputPolicy.systemPrompt !== undefined
      ? { systemPrompt: request.inputPolicy.systemPrompt }
      : {}),
    ...(request.inputPolicy.initialToolChoice !== undefined
      ? { toolChoice: request.inputPolicy.initialToolChoice }
      : {}),
  };
  // Replay of the accepted canonical input never reruns schema code (DR-023).
  const transition: ChatTurnTransition =
    active !== undefined &&
    !request.superseding &&
    !request.recoveryOnly &&
    !request.hasElicitResponses &&
    canonicalJson(active.input) !== canonicalJson(requestedInput)
      ? { kind: "supersede" }
      : { kind: "continue" };
  const input = active
    ? assertReplayedCanonicalValue<ChatProgramInput>(active.input)
    : requestedInput;
  const attach = {
    sessionId: request.conversationId,
    taskId,
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input,
    route: { driverKind: "program" },
    executionEpoch: recoveredExecutionEpoch,
    affinity: { kind: "conversation" as const, key: request.conversationId },
  };
  if (!active) {
    try {
      yield* journal.openTask({
        sessionId: request.conversationId,
        turnId,
        taskId,
        manifest,
        input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "workflow-host",
        elicitAudience: request.participantId,
      });
    } catch (error) {
      if (!(error instanceof CrankError) || error.code !== "invalid_journal") {
        throw error;
      }
      const raced = yield* journal.recoveryState(request.conversationId);
      if (
        raced.status !== "active" ||
        raced.taskId !== taskId ||
        canonicalJson(raced.input) !== canonicalJson(input)
      ) {
        throw new CrankError("idempotency_conflict", "Concurrent root task input differs");
      }
    }
    before = yield* journal.readJournal(request.conversationId, taskId);
  }
  request.onTaskReady?.(taskId);
  return {
    journal,
    ...(active === undefined ? {} : { active }),
    taskId,
    before,
    input,
    attach,
    transition,
  };
}

function ephemeralToolEntry(
  request: ChatAdmissionRequest,
  tool: string,
): ChatToolCatalogEntry["execution"] {
  if (request.ephemeral.kind === "none") {
    throw new CrankError(
      "tool_runtime_not_installed",
      `No execution strategy exists for ephemeral tool ${tool}`,
    );
  }
  return {
    kind: "ephemeral-tool",
    target: tool,
    driver: request.ephemeral.driver,
    tool,
    durability: "ephemeral_handle",
  };
}

function createChatToolCatalog(request: ChatAdmissionRequest): ChatToolCatalog {
  const nativePrograms = request.nativePrograms;
  const entries: Record<string, ChatToolCatalogEntry> = {};
  const sortedTools = [...request.tools].sort((left, right) => left.name.localeCompare(right.name));
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
        : ephemeralToolEntry(request, tool.name),
    };
  }
  return {
    version: 1,
    digest: canonicalDigest({ version: 1, entries }),
    entries,
  };
}
