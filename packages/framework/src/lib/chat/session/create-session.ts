import {
  spawn,
  each,
  createChannel,
  createSignal,
  resource,
  useScope,
  call,
  type Operation,
  type Task,
  type Channel,
  type Signal,
  type Stream,
  type Subscription,
} from "effection";
import { streamChatOnce } from "./stream-chat.ts";
import type { ElicitResponseData } from "./options.ts";
import { useTransformPipeline } from "./transforms.ts";
import { chatReducer, initialChatState } from "../state/reducer.ts";
import type { ChatState } from "../state/chat-state.ts";
import { StreamerContext, BaseUrlContext } from "./contexts.ts";
import type { ChatStateEvent } from "../state/events.ts";
import type { Message } from "../types.ts";
import type { ChatCommand, SessionOptions, Streamer, ChatEventTransform } from "./options.ts";
import type { ConversationReplayState, StreamResult } from "./streaming.ts";
import {
  syncConversationStateForElicit,
  syncConversationStateForComplete,
  syncMessagesFromIndex,
} from "./turn-manager.ts";
import {
  appendAssistantFinalMessage,
  appendToolMessage,
  appendUserMessage,
  createTranscriptState,
  resetTranscriptState,
} from "./transcript.ts";
import { readDurableHistory } from "./durable-history.ts";

const defaultStreamer: Streamer = streamChatOnce;

function createBufferedStateSignal<T>() {
  const values: T[] = [];
  const signal = createSignal<T, void>();

  return {
    send(value: T) {
      values.push(value);
      signal.send(value);
    },
    *subscribe(): Operation<Stream<T, void>> {
      const live: Subscription<T, void> = yield* signal;
      let replayIndex = 0;

      return resource(function* (provide) {
        yield* provide({
          *next(): Operation<IteratorResult<T, void>> {
            if (replayIndex < values.length) {
              return { done: false, value: values[replayIndex++]! };
            }
            return yield* live.next();
          },
        });
      });
    },
  };
}

export interface ClientToolSessionOptions extends SessionOptions {}

export interface ChatSession {
  state: Stream<ChatState, void>;
  dispatch: (command: ChatCommand) => void;
}

export function createChatSession(options: ClientToolSessionOptions = {}): Operation<ChatSession> {
  return resource(function* (provide) {
    const scope = yield* useScope();
    const commands = createSignal<ChatCommand, void>();
    const events = createChannel<ChatStateEvent, void>();
    const stateSignal = createBufferedStateSignal<ChatState>();

    if (options.baseUrl) {
      yield* BaseUrlContext.set(options.baseUrl);
    }
    if (options.streamer) {
      yield* StreamerContext.set(options.streamer);
    }

    yield* spawn(() => runChatSession(commands, events, options));

    yield* spawn(function* () {
      let currentState = initialChatState;
      stateSignal.send(currentState);

      for (const event of yield* each(events)) {
        currentState = chatReducer(currentState, event);
        stateSignal.send(currentState);
        yield* each.next();
      }
    });

    yield* provide({
      state: yield* stateSignal.subscribe(),
      dispatch: (cmd) =>
        scope.run(function* () {
          yield* call(() => {
            commands.send(cmd);
            return undefined;
          });
        }),
    });
  });
}

function createRunTerminalAcknowledger(onForwarded: () => void): ChatEventTransform {
  return function* (input, output) {
    for (const event of yield* each(input)) {
      yield* output.send(event);
      if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
        onForwarded();
      }
      yield* each.next();
    }
  };
}

function finalAssistantMessage(
  history: Message[],
  transcriptState: ReturnType<typeof createTranscriptState>,
  content: string,
): Message {
  const last = history[history.length - 1];
  if (last && last.role === "assistant" && last.content === content && !last.tool_calls?.length) {
    return last;
  }
  return appendAssistantFinalMessage(history, transcriptState, content);
}

export function* runChatSession(
  commands: Signal<ChatCommand, void>,
  events: Channel<ChatStateEvent, void>,
  options: ClientToolSessionOptions = {},
): Operation<void> {
  const history: Message[] = [];
  const transcriptState = createTranscriptState(history);
  let currentRequestTask: Task<StreamResult> | null = null;
  const pendingElicitResponses: ElicitResponseData[] = [];
  const sentElicitResponseIds = new Set<string>();
  let pendingToolCalls: Array<{ id: string; name: string }> = [];
  // Authoritative open elicits for this session. mirroredState can lag or be
  // incomplete for cancel-on-send, so we track them explicitly when turns park.
  let openElicits: Array<{
    sessionId: string;
    callId: string;
    toolName?: string;
    elicitId: string;
  }> = [];
  let replayState: ConversationReplayState | undefined;
  let mirroredState = initialChatState;
  // Capture/reuse the server-minted conversation identity so multi-turn
  // requests stay on the same fold session even when the demo does not
  // pre-provision a conversationId (flight/cards/etc).
  let conversationId = options.conversationId;

  function* sendEvent(event: ChatStateEvent): Operation<void> {
    mirroredState = chatReducer(mirroredState, event);
    yield* events.send(event);
  }

  if (options.conversationId) {
    const contextBaseUrl = yield* BaseUrlContext.get();
    const baseUrl = options.baseUrl ?? contextBaseUrl ?? "/api/chat";
    const replayTools = [
      ...(options.tools ?? []),
      ...(options.plugins ?? []).map((plugin) => ({
        name: plugin.client.toolName,
        ...(plugin.client.replayTrace ? { replayTrace: plugin.client.replayTrace } : {}),
      })),
    ];
    const durableHistory = yield* readDurableHistory({
      baseUrl,
      conversationId: options.conversationId,
      ...(replayTools.length > 0 ? { tools: replayTools } : {}),
      ...((options.transforms?.length ?? 0) > 0 ? { transforms: options.transforms } : {}),
      ...(options.onStreamEvent ? { onStreamEvent: options.onStreamEvent } : {}),
    });

    for (const message of durableHistory.history) {
      history.push(message);
    }
    resetTranscriptState(transcriptState, history);
    replayState = durableHistory.replayState;

    for (const event of durableHistory.events) {
      yield* sendEvent(event);
    }
  }

  function* startRequest(): Operation<StreamResult> {
    let terminalForwarded = false;
    let terminalForwardedResolve: (() => void) | null = null;

    function waitForTerminalForwarded(): Promise<void> {
      if (terminalForwarded) return Promise.resolve();
      return new Promise<void>((resolve) => {
        terminalForwardedResolve = resolve;
      });
    }

    const terminalAcknowledger = createRunTerminalAcknowledger(() => {
      if (terminalForwarded) return;
      terminalForwarded = true;
      terminalForwardedResolve?.();
      terminalForwardedResolve = null;
    });
    const mirrorEventState: ChatEventTransform = function* (input, output) {
      for (const event of yield* each(input)) {
        mirroredState = chatReducer(mirroredState, event);
        yield* output.send(event);
        yield* each.next();
      }
    };

    const streamEvents = yield* useTransformPipeline(events, [
      mirrorEventState,
      ...(options.transforms ?? []),
      terminalAcknowledger,
    ]);

    const contextStreamer = yield* StreamerContext.get();
    const streamer = contextStreamer ?? options.streamer ?? defaultStreamer;
    const originalHistoryLength = history.length;
    let result: StreamResult;

    while (true) {
      const elicitResponsesToSend = pendingElicitResponses.splice(0);
      try {
        result = yield* streamer([...history], streamEvents, {
          ...options,
          ...(conversationId ? { conversationId } : {}),
          ...(elicitResponsesToSend.length > 0 ? { elicitResponses: elicitResponsesToSend } : {}),
          ...(replayState ? { replayState } : {}),
        });
      } catch (error) {
        yield* streamEvents.close();
        if (terminalForwarded) yield* call(waitForTerminalForwarded);
        throw error;
      }

      if (result.conversationId) {
        conversationId = result.conversationId;
      }

      if (result.type === "complete") {
        const toolResultsMap = new Map(
          (result.toolResults ?? []).map((toolResult) => [toolResult.id, toolResult.content]),
        );
        syncMessagesFromIndex(
          history,
          mirroredState.messages,
          originalHistoryLength,
          toolResultsMap,
        );
        if (result.conversationState) {
          syncConversationStateForComplete(history, result.conversationState);
          replayState = result.conversationState.replay ?? replayState;
        }
        resetTranscriptState(transcriptState, history);
        pendingToolCalls = [];
        openElicits = [];
        break;
      }

      if (result.type === "elicit") {
        syncMessagesFromIndex(history, mirroredState.messages, originalHistoryLength);
        pendingToolCalls = syncConversationStateForElicit(history, result.conversationState);
        resetTranscriptState(transcriptState, history);
        replayState = result.conversationState.replay ?? replayState;
        openElicits = result.pendingElicitations.map((elicit) => ({
          sessionId: elicit.sessionId,
          callId: elicit.callId,
          ...(elicit.toolName ? { toolName: elicit.toolName } : {}),
          elicitId: elicit.elicitId,
        }));

        break;
      }

      break;
    }

    if (result!.type === "complete") {
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
        finalAssistantMessage(history, transcriptState, finalContent);
      }
    }

    // Closing drains every queued event through transforms. Check the terminal
    // invariant only after the drain so custom streamers cannot deadlock us by
    // returning without RUN_FINISHED/RUN_ERROR.
    yield* streamEvents.close();
    if (!terminalForwarded) {
      throw new Error("Streamer returned without a terminal AG-UI event");
    }
    yield* call(waitForTerminalForwarded);
    return result!;
  }

  for (const cmd of yield* each(commands)) {
    switch (cmd.type) {
      case "send": {
        if (currentRequestTask) {
          const partialContent = cmd.partialContent?.trim();
          if (partialContent) {
            const partialMessage = appendAssistantFinalMessage(
              history,
              transcriptState,
              cmd.partialContent!,
            );
            yield* sendEvent({
              type: "LOCAL_ASSISTANT_MESSAGE",
              message: partialMessage,
              partial: true,
            });
          }
          yield* currentRequestTask.halt();
          currentRequestTask = null;
        }

        if (pendingToolCalls.length > 0) {
          for (const tc of pendingToolCalls) {
            appendToolMessage(
              history,
              transcriptState,
              tc.id,
              "Tool execution was cancelled by user sending a new message.",
            );
          }
          pendingToolCalls = [];
        }

        // Free-form send supersedes any still-open plugin elicits. Cancel them
        // so the server interrupt registry does not reject the request with
        // "Open interrupts require resume[]".
        if (openElicits.length > 0) {
          for (const elicit of openElicits) {
            if (sentElicitResponseIds.has(elicit.elicitId)) continue;
            sentElicitResponseIds.add(elicit.elicitId);
            pendingElicitResponses.push({
              sessionId: elicit.sessionId,
              callId: elicit.callId,
              ...(elicit.toolName ? { toolName: elicit.toolName } : {}),
              elicitId: elicit.elicitId,
              result: { action: "cancel" },
            });
            yield* sendEvent({
              type: "LOCAL_ELICIT_RESPONSE",
              callId: elicit.callId,
              elicitId: elicit.elicitId,
              response: { action: "cancel" },
            });
          }
          openElicits = [];
        }

        const userMessage = appendUserMessage(history, transcriptState, cmd.content);
        yield* sendEvent({ type: "LOCAL_USER_MESSAGE", message: userMessage });

        currentRequestTask = yield* spawn(function* () {
          try {
            return yield* startRequest();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            yield* sendEvent({ type: "LOCAL_ERROR", message });
            throw error;
          } finally {
            currentRequestTask = null;
          }
        });
        break;
      }

      case "continue": {
        if (currentRequestTask) {
          yield* currentRequestTask.halt();
          currentRequestTask = null;
        }

        currentRequestTask = yield* spawn(function* () {
          try {
            return yield* startRequest();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            yield* sendEvent({ type: "LOCAL_ERROR", message });
            throw error;
          } finally {
            currentRequestTask = null;
          }
        });
        break;
      }

      case "abort": {
        if (currentRequestTask) {
          yield* currentRequestTask.halt();
          currentRequestTask = null;
        }

        const preservePartial = options.preservePartialOnAbort ?? true;
        const suffix = options.abortSuffix ?? "";
        if (preservePartial && cmd.partialContent?.trim()) {
          const partialMessage: Message = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: cmd.partialContent + suffix,
            partial: true,
          };
          history.push(partialMessage);
          yield* sendEvent({ type: "LOCAL_ABORT", message: partialMessage });
        } else {
          yield* sendEvent({ type: "LOCAL_ABORT" });
        }
        break;
      }

      case "reset": {
        if (currentRequestTask) {
          yield* currentRequestTask.halt();
          currentRequestTask = null;
        }
        history.length = 0;
        pendingElicitResponses.length = 0;
        pendingToolCalls = [];
        openElicits = [];
        sentElicitResponseIds.clear();
        resetTranscriptState(transcriptState, history);
        yield* sendEvent({ type: "LOCAL_RESET" });
        break;
      }

      case "elicit_response": {
        if (sentElicitResponseIds.has(cmd.elicitId)) {
          break;
        }
        sentElicitResponseIds.add(cmd.elicitId);
        openElicits = openElicits.filter((elicit) => elicit.elicitId !== cmd.elicitId);

        pendingElicitResponses.push({
          sessionId: cmd.sessionId,
          callId: cmd.callId,
          ...(cmd.toolName ? { toolName: cmd.toolName } : {}),
          ...(cmd.ref ? { ref: cmd.ref } : {}),
          elicitId: cmd.elicitId,
          result: cmd.result,
          ...(cmd.trace ? { trace: cmd.trace } : {}),
        });

        yield* sendEvent({
          type: "LOCAL_ELICIT_RESPONSE",
          callId: cmd.callId,
          elicitId: cmd.elicitId,
          response: cmd.result,
        });

        if (cmd.autoContinue !== false) {
          commands.send({ type: "continue" });
        }
        break;
      }
    }

    yield* each.next();
  }
}
