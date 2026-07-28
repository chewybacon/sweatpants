/**
 * lib/chat/session/turn-state.ts
 *
 * Pure turn-lifecycle state for a chat session.
 *
 * All history/transcript/elicit bookkeeping for a session lives here as
 * deterministic transitions with no I/O. Transitions return the local
 * `ChatStateEvent`s the session loop must emit, in order. The session loop
 * (`create-session.ts`) owns only transport and task lifecycle: spawning and
 * halting requests, transform pipelines, and channel plumbing.
 */
import { chatReducer, initialChatState } from "../state/reducer.ts";
import type { ChatState } from "../state/chat-state.ts";
import type { ChatStateEvent } from "../state/events.ts";
import type { Message } from "../messages.ts";
import type { ElicitResponseData } from "./options.ts";
import type { ConversationReplayState, StreamResult } from "./streaming.ts";
import {
  syncConversationStateForComplete,
  syncConversationStateForElicit,
  syncMessagesFromIndex,
  type PendingToolCall,
} from "./turn-manager.ts";
import {
  appendAssistantFinalMessage,
  appendToolMessage,
  appendUserMessage,
  createTranscriptState,
  resetTranscriptState,
} from "./transcript.ts";

export interface OpenElicit {
  sessionId: string;
  callId: string;
  toolName?: string;
  elicitId: string;
}

export interface TurnRequestInput {
  conversationId: string | undefined;
  elicitResponses: ElicitResponseData[];
  replayState: ConversationReplayState | undefined;
  originalHistoryLength: number;
}

export interface ElicitResponseCommand {
  sessionId: string;
  callId: string;
  toolName?: string;
  ref?: ElicitResponseData["ref"];
  elicitId: string;
  result: ElicitResponseData["result"];
  trace?: ElicitResponseData["trace"];
}

export interface ChatTurnState {
  /** Session transcript. Callers must treat the array as owned by this state. */
  readonly history: Message[];
  /** Mirrored reducer fold of every event this session has emitted or streamed. */
  readonly mirrored: ChatState;
  readonly conversationId: string | undefined;
  /** Fold a streamed or local event into the mirrored state. */
  fold(event: ChatStateEvent): void;
  /** Install replayed durable history before the command loop starts. */
  loadDurableHistory(messages: Message[], replayState: ConversationReplayState | undefined): void;
  /** Snapshot the inputs for one streamer request, consuming queued elicit responses. */
  beginTurnRequest(): TurnRequestInput;
  /** Record the server-minted conversation identity from a stream result. */
  recordConversationId(result: StreamResult): void;
  /**
   * Repair history after a failed request. RUN_ERROR may follow projected
   * tool-call/error-result events; persist those mirrored messages so the next
   * turn does not inherit an unexplained hanging tool call, and preserve any
   * streamed partial assistant text.
   */
  commitFailure(originalHistoryLength: number): void;
  /** Fold a terminal `complete` stream result into history. */
  commitComplete(
    result: Extract<StreamResult, { type: "complete" }>,
    originalHistoryLength: number,
  ): void;
  /** Fold a parked `elicit` stream result into history. */
  commitElicit(
    result: Extract<StreamResult, { type: "elicit" }>,
    originalHistoryLength: number,
  ): void;
  /**
   * Begin a user send. Supersedes any in-flight turn bookkeeping: records the
   * interrupted partial, cancels parked tool calls, and cancels open elicits
   * without resuming their tool business logic.
   */
  send(content: string, partialContent?: string): ChatStateEvent[];
  /** Begin a user abort, optionally preserving streamed partial text. */
  abort(
    partialContent: string | undefined,
    options: { preservePartial: boolean; suffix: string },
  ): ChatStateEvent[];
  /** Clear every piece of turn state. */
  reset(): ChatStateEvent[];
  /**
   * Queue an elicit response for the next request. Returns null when this
   * elicitId already responded (duplicate suppression).
   */
  elicitResponse(command: ElicitResponseCommand): ChatStateEvent[] | null;
}

export function createChatTurnState(initialConversationId?: string): ChatTurnState {
  const history: Message[] = [];
  const transcriptState = createTranscriptState(history);
  const pendingElicitResponses: ElicitResponseData[] = [];
  const sentElicitResponseIds = new Set<string>();
  let pendingToolCalls: PendingToolCall[] = [];
  // Authoritative open elicits for this session. The mirrored state can lag or
  // be incomplete for cancel-on-send, so track them explicitly on park.
  let openElicits: OpenElicit[] = [];
  let replayState: ConversationReplayState | undefined;
  let mirrored = initialChatState;
  // Capture/reuse the server-minted conversation identity so multi-turn
  // requests stay on the same durable session even when the application does
  // not pre-provision a conversationId.
  let conversationId = initialConversationId;

  function finalAssistantMessage(content: string): Message {
    const last = history[history.length - 1];
    if (last && last.role === "assistant" && last.content === content && !last.tool_calls?.length) {
      return last;
    }
    return appendAssistantFinalMessage(history, transcriptState, content);
  }

  return {
    history,
    get mirrored() {
      return mirrored;
    },
    get conversationId() {
      return conversationId;
    },

    fold(event) {
      mirrored = chatReducer(mirrored, event);
    },

    loadDurableHistory(messages, durableReplayState) {
      for (const message of messages) {
        history.push(message);
      }
      resetTranscriptState(transcriptState, history);
      replayState = durableReplayState;
    },

    beginTurnRequest() {
      return {
        conversationId,
        elicitResponses: pendingElicitResponses.splice(0),
        replayState,
        originalHistoryLength: history.length,
      };
    },

    recordConversationId(result) {
      if (result.conversationId) {
        conversationId = result.conversationId;
      }
    },

    commitFailure(originalHistoryLength) {
      syncMessagesFromIndex(history, mirrored.messages, originalHistoryLength);
      const visiblePartial = mirrored.streaming.parts
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
      resetTranscriptState(transcriptState, history);
    },

    commitComplete(result, originalHistoryLength) {
      const toolResultsMap = new Map(
        (result.toolResults ?? []).map((toolResult) => [toolResult.id, toolResult.content]),
      );
      syncMessagesFromIndex(history, mirrored.messages, originalHistoryLength, toolResultsMap);
      if (result.conversationState) {
        syncConversationStateForComplete(history, result.conversationState);
        replayState = result.conversationState.replay ?? replayState;
      }
      if ((result.toolResults?.length ?? 0) > 0) {
        // The folded client state observes terminal assistant text before the
        // request result exposes server tool results. Defer newly projected
        // plain assistant messages so causal history remains call -> result ->
        // terminal assistant, and append the terminal text exactly once below.
        for (let index = history.length - 1; index >= originalHistoryLength; index -= 1) {
          const message = history[index]!;
          if (message.role === "assistant" && !message.tool_calls?.length) {
            history.splice(index, 1);
          }
        }
      }
      resetTranscriptState(transcriptState, history);
      pendingToolCalls = [];
      openElicits = [];

      for (const toolResult of result.toolResults ?? []) {
        const exists = history.some(
          (message) => message.role === "tool" && message.tool_call_id === toolResult.id,
        );
        if (!exists) {
          appendToolMessage(history, transcriptState, toolResult.id, toolResult.content, {
            toolName: toolResult.name,
          });
        }
      }

      const finalContent = result.text || result.conversationState?.assistantContent || "";
      if (finalContent || originalHistoryLength === history.length) {
        finalAssistantMessage(finalContent);
      }
    },

    commitElicit(result, originalHistoryLength) {
      syncMessagesFromIndex(history, mirrored.messages, originalHistoryLength);
      pendingToolCalls = syncConversationStateForElicit(history, result.conversationState);
      resetTranscriptState(transcriptState, history);
      replayState = result.conversationState.replay ?? replayState;
      openElicits = result.pendingElicitations.map((elicit) => ({
        sessionId: elicit.sessionId,
        callId: elicit.callId,
        ...(elicit.toolName ? { toolName: elicit.toolName } : {}),
        elicitId: elicit.elicitId,
      }));
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

      for (const toolCall of pendingToolCalls) {
        appendToolMessage(
          history,
          transcriptState,
          toolCall.id,
          "Tool execution was cancelled by user sending a new message.",
        );
      }
      pendingToolCalls = [];

      // Free-form send supersedes any still-open plugin elicits. Do not
      // serialize these as ordinary `{ action: "cancel" }` responses: that
      // resumes tool business logic and can trigger a terminal model sample.
      // A response-free request lets the handler select its pluginAbort path
      // and continue the replacement user turn in the same activation.
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
      pendingToolCalls = [];
      openElicits = [];
      sentElicitResponseIds.clear();
      resetTranscriptState(transcriptState, history);
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
        result: command.result,
        ...(command.trace ? { trace: command.trace } : {}),
      });

      return [
        {
          type: "LOCAL_ELICIT_RESPONSE",
          callId: command.callId,
          elicitId: command.elicitId,
          response: command.result,
        },
      ];
    },
  };
}
