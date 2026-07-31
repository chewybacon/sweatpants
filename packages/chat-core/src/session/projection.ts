import type { ChatState, ChatStateInternal } from "../state/chat-state.ts";
import type { ChatStateEvent } from "../state/events.ts";
import type { Message } from "../messages.ts";
import { assertMessageHasId } from "./message-identity.ts";
import type { ElicitResponseData } from "./options.ts";
import type { ConversationReplayState, ElicitRequestStreamEvent } from "./streaming.ts";
import type { ChatTransportReceipt, ChatTurnSettlement } from "./settlement.ts";
import { reduceChatState } from "../state/reducer.ts";
import { initialChatStateInternal } from "../state/chat-state.ts";
import {
  appendAssistantFinalMessage,
  appendToolMessage,
  appendUserMessage,
  createTranscriptState,
  resetTranscriptState,
} from "./transcript.ts";

export interface TurnRequestInput {
  conversationId: string | undefined;
  elicitResponses: ElicitResponseData[];
  replayState: ConversationReplayState | undefined;
}

export interface ElicitResponseCommand {
  sessionId: string;
  callId: string;
  toolName?: string;
  ref?: ElicitResponseData["ref"];
  elicitId: string;
  completion: ElicitResponseData["completion"];
  trace?: ElicitResponseData["trace"];
}

interface OpenElicit {
  sessionId: string;
  callId: string;
  toolName?: string;
  elicitId: string;
}

/**
 * The only production fold entry point for Chat Core state.
 *
 * Replay and the live session both use this small state projection. The live
 * session projection below additionally owns durable history and turn
 * settlement; neither transport nor consumers reconstructs a second result.
 */
export interface ChatStateProjection {
  readonly state: ChatState;
  fold(event: ChatStateEvent): void;
  reset(): void;
}

function publicState(state: ChatStateInternal): ChatState {
  const { messageDrafts: _messageDrafts, toolCallDrafts: _toolCallDrafts, ...view } = state;
  return view;
}

export function createChatStateProjection(): ChatStateProjection {
  let state: ChatStateInternal = initialChatStateInternal;

  return {
    get state() {
      return publicState(state);
    },
    fold(event) {
      state = reduceChatState(state, event);
    },
    reset() {
      state = initialChatStateInternal;
    },
  };
}

export interface ChatSessionProjection {
  /** The retained provider history owned by this client session. */
  readonly history: Message[];
  /** The public state view derived by the same fold as history. */
  readonly state: ChatState;
  readonly conversationId: string | undefined;
  fold(event: ChatStateEvent): void;
  loadDurableHistory(messages: Message[], replayState: ConversationReplayState | undefined): void;
  beginTurnRequest(): TurnRequestInput;
  recordConversationId(receipt: ChatTransportReceipt): void;
  settle(): ChatTurnSettlement;
  fail(): void;
  send(content: string, partialContent?: string): ChatStateEvent[];
  abort(
    partialContent: string | undefined,
    options: { preservePartial: boolean; suffix: string },
  ): ChatStateEvent[];
  reset(): ChatStateEvent[];
  elicitResponse(command: ElicitResponseCommand): ChatStateEvent[] | null;
}

function pendingElicitations(state: ChatState): ElicitRequestStreamEvent[] {
  return Object.values(state.pendingElicits)
    .flatMap((tracking) => tracking.elicitations)
    .filter((elicit) => elicit.status === "pending")
    .map((elicit) => ({
      type: "elicit_request" as const,
      sessionId: elicit.sessionId,
      callId: elicit.callId,
      toolName: elicit.toolName,
      elicitId: elicit.elicitId,
      key: elicit.key,
      message: elicit.message,
      schema: elicit.schema,
    }));
}

function openElicitsFromState(state: ChatState): OpenElicit[] {
  return pendingElicitations(state).map((elicit) => ({
    sessionId: elicit.sessionId,
    callId: elicit.callId,
    toolName: elicit.toolName,
    elicitId: elicit.elicitId,
  }));
}

function currentMessages(state: ChatState, historyStart: number): Message[] {
  return state.messages.slice(historyStart).map((message) => ({
    ...message,
    id: assertMessageHasId(message, "ChatSessionProjection.currentMessages"),
  }));
}

function causalMessages(messages: Message[]): Message[] {
  if (!messages.some((message) => message.role === "tool")) {
    return messages;
  }

  const firstToolCall = messages.findIndex(
    (message) => message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0,
  );
  const deferred: Message[] = [];
  const ordered: Message[] = [];
  for (const [index, message] of messages.entries()) {
    const terminalAssistant =
      message.role === "assistant" &&
      (message.tool_calls?.length ?? 0) === 0 &&
      (firstToolCall < 0 || index > firstToolCall);
    if (terminalAssistant) {
      deferred.push(message);
    } else {
      ordered.push(message);
    }
  }
  return [...ordered, ...deferred];
}

function pendingToolCalls(messages: Message[]): Array<{ id: string; name: string }> {
  const completed = new Set(
    messages
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => message.tool_call_id!),
  );
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? (message.tool_calls ?? []) : [],
  );
  return calls
    .filter((call) => !completed.has(call.id))
    .map((call) => ({ id: call.id, name: call.function.name }));
}

function upsertHistoryMessage(history: Message[], message: Message): void {
  const index = history.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) {
    history.push(message);
  } else {
    history[index] = message;
  }
}

export function createChatSessionProjection(initialConversationId?: string): ChatSessionProjection {
  const stateProjection = createChatStateProjection();
  const history: Message[] = [];
  const transcriptState = createTranscriptState(history);
  const pendingElicitResponses: ElicitResponseData[] = [];
  const sentElicitResponseIds = new Set<string>();
  let pendingCalls: Array<{ id: string; name: string }> = [];
  let openElicits: OpenElicit[] = [];
  let replayState: ConversationReplayState | undefined;
  let conversationId = initialConversationId;
  let activeHistoryStart: number | undefined;

  function materializeCurrentTurn(preservePartial: boolean): Message[] {
    const start = activeHistoryStart ?? history.length;
    const messages = causalMessages(currentMessages(stateProjection.state, start));
    for (const message of messages) {
      upsertHistoryMessage(history, message);
    }
    resetTranscriptState(transcriptState, history);

    if (preservePartial) {
      const visiblePartial = stateProjection.state.streaming.parts
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("");
      if (
        visiblePartial &&
        !history.some(
          (message) => message.role === "assistant" && message.content === visiblePartial,
        )
      ) {
        const partial = appendAssistantFinalMessage(history, transcriptState, visiblePartial);
        partial.partial = true;
      }
    }

    return messages;
  }

  function settlePendingCalls(messages: Message[]): void {
    pendingCalls = pendingToolCalls(messages);
    openElicits = openElicitsFromState(stateProjection.state);
  }

  return {
    history,
    get state() {
      return stateProjection.state;
    },
    get conversationId() {
      return conversationId;
    },

    fold(event) {
      stateProjection.fold(event);
      if (stateProjection.state.replay) {
        replayState = stateProjection.state.replay;
      }
      if (event.type === "RUN_FINISHED" && event.outcome?.type === "interrupt") {
        openElicits = event.outcome.interrupts
          .filter((interrupt) => interrupt.toolCallId)
          .map((interrupt) => ({
            sessionId: interrupt.toolCallId!,
            callId: interrupt.toolCallId!,
            ...(typeof interrupt.metadata?.["sweatpants/toolName"] === "string"
              ? { toolName: interrupt.metadata["sweatpants/toolName"] }
              : {}),
            elicitId: interrupt.id,
          }));
      }
      if (event.type === "TOOL_CALL_RESULT") {
        openElicits = openElicits.filter((elicit) => elicit.callId !== event.toolCallId);
      }
      if (event.type === "LOCAL_ELICIT_RESPONSE") {
        openElicits = openElicits.filter((elicit) => elicit.elicitId !== event.elicitId);
      }
    },

    loadDurableHistory(messages, durableReplayState) {
      history.push(...messages);
      resetTranscriptState(transcriptState, history);
      replayState = durableReplayState;
    },

    beginTurnRequest() {
      activeHistoryStart = history.length;
      return {
        conversationId,
        elicitResponses: pendingElicitResponses.splice(0),
        replayState,
      };
    },

    recordConversationId(receipt) {
      if (receipt.conversationId) {
        conversationId = receipt.conversationId;
      }
    },

    settle() {
      const messages = materializeCurrentTurn(false);
      const pending = pendingElicitations(stateProjection.state);
      settlePendingCalls(messages);
      activeHistoryStart = undefined;

      if (pending.length > 0) {
        return { outcome: "interrupt", pendingElicitations: pending };
      }

      pendingCalls = [];
      openElicits = [];
      if (messages.length === 0) {
        appendAssistantFinalMessage(history, transcriptState, "");
      }
      return { outcome: "complete" };
    },

    fail() {
      const messages = materializeCurrentTurn(true);
      settlePendingCalls(messages);
      activeHistoryStart = undefined;
    },

    send(content, partialContent) {
      const events: ChatStateEvent[] = [];
      const trimmedPartial = partialContent?.trim();
      if (trimmedPartial) {
        const partialMessage = appendAssistantFinalMessage(
          history,
          transcriptState,
          partialContent!,
        );
        events.push({
          type: "LOCAL_ASSISTANT_MESSAGE",
          message: partialMessage,
          partial: true,
        });
      }

      for (const toolCall of pendingCalls) {
        appendToolMessage(
          history,
          transcriptState,
          toolCall.id,
          toolCall.name,
          "Tool execution was cancelled by user sending a new message.",
          true,
        );
      }
      pendingCalls = [];

      for (const elicit of openElicits) {
        if (sentElicitResponseIds.has(elicit.elicitId)) {
          continue;
        }
        sentElicitResponseIds.add(elicit.elicitId);
        events.push({
          type: "LOCAL_ELICIT_RESPONSE",
          callId: elicit.callId,
          elicitId: elicit.elicitId,
          response: { action: "cancel" },
        });
      }
      openElicits = [];

      const userMessage = appendUserMessage(history, transcriptState, content);
      events.push({ type: "LOCAL_USER_MESSAGE", message: userMessage });
      return events;
    },

    abort(partialContent, { preservePartial, suffix }) {
      if (preservePartial && partialContent?.trim()) {
        const partialMessage: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: partialContent + suffix,
          partial: true,
        };
        history.push(partialMessage);
        return [{ type: "LOCAL_ABORT", message: partialMessage }];
      }
      return [{ type: "LOCAL_ABORT" }];
    },

    reset() {
      history.length = 0;
      pendingElicitResponses.length = 0;
      pendingCalls = [];
      openElicits = [];
      sentElicitResponseIds.clear();
      activeHistoryStart = undefined;
      transcriptState.currentTurnKey = "u1";
      resetTranscriptState(transcriptState, history);
      stateProjection.reset();
      return [{ type: "LOCAL_RESET" }];
    },

    elicitResponse(command) {
      if (sentElicitResponseIds.has(command.elicitId)) {
        return null;
      }
      sentElicitResponseIds.add(command.elicitId);
      openElicits = openElicits.filter((elicit) => elicit.elicitId !== command.elicitId);
      pendingElicitResponses.push({
        sessionId: command.sessionId,
        callId: command.callId,
        ...(command.toolName ? { toolName: command.toolName } : {}),
        ...(command.ref ? { ref: command.ref } : {}),
        elicitId: command.elicitId,
        completion: command.completion,
        ...(command.trace ? { trace: command.trace } : {}),
      });
      return [
        {
          type: "LOCAL_ELICIT_RESPONSE",
          callId: command.callId,
          elicitId: command.elicitId,
          response: command.completion,
        },
      ];
    },
  };
}
