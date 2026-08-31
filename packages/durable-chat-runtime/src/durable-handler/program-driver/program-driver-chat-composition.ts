import { CrankError, type PinnedProgram } from "@sweatpants/durable-execution";
import { nativeProgramIdentities } from "../../program-driver/native-tools.ts";
import type { ChatActivationContext } from "./program-driver-chat-activation.ts";
import type {
  ChatAdmissionInputPolicy,
  ChatAdmissionRequest,
} from "./program-driver-chat-admission.ts";
import type { ChatPresentationContext } from "./program-driver-chat-presentation.ts";
import type {
  ChatExecutionEnvironment,
  ChatSamplingPolicy,
  EphemeralExecutionStrategy,
} from "./program-driver-chat-runtime.ts";
import type { ElicitSettlementRequest } from "./program-driver-chat-settlement.ts";
import type { ProgramDriverChatEngineParams } from "./program-driver-chat-types.ts";

export interface ProgramDriverChatComposition {
  readonly activation: ChatActivationContext;
  readonly presentation: ChatPresentationContext;
}

/** The sole translation from the product parameter bag into domain capabilities. */
export function composeProgramDriverChat(
  params: ProgramDriverChatEngineParams,
): ProgramDriverChatComposition {
  if (params.modelContextSource === undefined) {
    throw new CrankError(
      "model_context_source_invalid",
      "Chat-root execution requires an authoritative conversation context source",
    );
  }
  const nativePrograms = nativeProgramIdentities(params.nativeTools);
  const ephemeral = decideEphemeralExecution(params, nativePrograms);
  const inputPolicy: ChatAdmissionInputPolicy = {
    ...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }),
    ...(params.initialToolChoice === undefined
      ? {}
      : { initialToolChoice: params.initialToolChoice }),
  };
  const samplingPolicy: ChatSamplingPolicy = {
    ...(params.streamOptions === undefined ? {} : { streamOptions: params.streamOptions }),
    ...(params.historyPolicy === undefined ? {} : { historyPolicy: params.historyPolicy }),
  };
  const admission: ChatAdmissionRequest = {
    journalStore: params.journalStore,
    conversationId: params.conversationId,
    participantId: params.participantId,
    maxIterations: params.maxIterations,
    tools: params.toolSchemas,
    nativePrograms,
    ephemeral:
      ephemeral.kind === "none" ? { kind: "none" } : { kind: "driver", driver: ephemeral.kind },
    inputPolicy,
    recoveryOnly: params.recoveryOnly === true,
    superseding: params.pluginAbort !== undefined,
    hasElicitResponses: (params.elicitResponses?.length ?? 0) > 0,
    contextSource: params.modelContextSource,
    ...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }),
    ...(params.initialToolChoice === undefined
      ? {}
      : { initialToolChoice: params.initialToolChoice }),
    ...(params.onLiveTaskReady === undefined ? {} : { onTaskReady: params.onLiveTaskReady }),
  };
  const execution: ChatExecutionEnvironment = {
    sessionId: params.conversationId,
    sampling: {
      model: params.model,
      conversationStore: params.conversationStore,
      policy: samplingPolicy,
    },
    ...(params.nativeTools === undefined ? {} : { native: params.nativeTools }),
    ephemeral,
  };
  const settlement: ElicitSettlementRequest = {
    responses: params.elicitResponses ?? [],
    sessionId: params.conversationId,
    participantId: params.participantId,
    ...(params.nativeTools === undefined ? {} : { nativeBindings: params.nativeTools.bindings }),
  };
  return {
    activation: {
      admission,
      execution,
      settlement,
      sessionId: params.conversationId,
      participantId: params.participantId,
      ...(params.pluginAbort === undefined ? {} : { pluginAbort: params.pluginAbort }),
      ...(params.onResumeAccepted === undefined
        ? {}
        : { onResumeAccepted: params.onResumeAccepted }),
      ...(params.nativeTools === undefined ? {} : { native: params.nativeTools }),
    },
    presentation: {
      agUiRun: params.agUiRun,
      toolInventory: params.toolInventoryEntries ?? [],
      continueAfterCancellation: params.continueAfterCancellation === true,
      cancellationMessage: params.pluginAbort?.reason ?? "Program was cancelled",
      publishTerminal: params.publishTerminal,
      ...(params.publishCheckpoint === undefined
        ? {}
        : { publishCheckpoint: params.publishCheckpoint }),
    },
  };
}

function decideEphemeralExecution(
  params: ProgramDriverChatEngineParams,
  nativePrograms: Readonly<Record<string, PinnedProgram>>,
): EphemeralExecutionStrategy {
  const needsEphemeralExecution = params.toolSchemas.some(
    (tool) => nativePrograms[tool.name] === undefined,
  );
  if (!needsEphemeralExecution) return { kind: "none" };
  if (params.ephemeralEffects !== undefined) {
    return { kind: "tool-session", effects: params.ephemeralEffects };
  }
  if (params.toolRuntime !== undefined) {
    return {
      kind: "chat-tool-runtime",
      runtime: params.toolRuntime,
      inventory: params.toolInventoryEntries ?? [],
      threadId: params.agUiRun.threadId,
      runId: params.agUiRun.runId,
    };
  }
  throw new CrankError(
    "tool_runtime_not_installed",
    "Ephemeral tools require a composed execution strategy",
  );
}
