import { nativeProgramIdentities } from "../program-driver/native-tools.ts";
import type { ChatActivationContext } from "./program-driver-chat-activation.ts";
import type { ChatAdmissionRequest } from "./program-driver-chat-admission.ts";
import type { ChatPresentationContext } from "./program-driver-chat-presentation.ts";
import type { ChatExecutionEnvironment } from "./program-driver-chat-runtime.ts";
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
  const admission: ChatAdmissionRequest = {
    journalStore: params.journalStore,
    conversationId: params.conversationId,
    participantId: params.participantId,
    maxIterations: params.maxIterations,
    tools: params.toolSchemas,
    nativePrograms: nativeProgramIdentities(params.nativeTools),
    ephemeralDriver: params.foreignEffects ? "tool-session" : "chat-tool-runtime",
    recoveryOnly: params.recoveryOnly === true,
    superseding: params.pluginAbort !== undefined,
    hasElicitResponses: (params.elicitResponses?.length ?? 0) > 0,
    ...(params.modelContextSource === undefined
      ? {}
      : { contextSource: params.modelContextSource }),
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
      ...(params.streamOptions === undefined ? {} : { streamOptions: params.streamOptions }),
      ...(params.historyPolicy === undefined ? {} : { historyPolicy: params.historyPolicy }),
    },
    ...(params.nativeTools === undefined ? {} : { native: params.nativeTools }),
    ephemeral: {
      inventory: params.toolInventoryEntries ?? [],
      threadId: params.agUiRun.threadId,
      runId: params.agUiRun.runId,
      ...(params.foreignEffects === undefined ? {} : { effects: params.foreignEffects }),
      ...(params.toolRuntime === undefined ? {} : { runtime: params.toolRuntime }),
    },
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
