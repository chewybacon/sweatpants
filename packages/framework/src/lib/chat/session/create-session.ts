import {
  spawn,
  each,
  createSignal,
  resource,
  useScope,
  call,
  type Operation,
  type Channel,
  type Stream,
  type Subscription,
} from "effection";
import { streamChatOnce } from "./stream-chat.ts";
import type { ElicitResponseData } from "./options.ts";
import { useBufferedChannel, useTransformPipeline } from "./transforms.ts";
import { chatReducer, initialChatState } from "../state/reducer.ts";
import type { ChatState } from "../state/chat-state.ts";
import { StreamerContext, BaseUrlContext } from "./contexts.ts";
import type { ChatStateEvent } from "../state/events.ts";
import type { Message } from "../types.ts";
import type {
  ChatCommand,
  SessionOptions,
  StreamChatOptions,
  Streamer,
  ChatEventTransform,
} from "./options.ts";
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
    const commands = yield* useBufferedChannel<ChatCommand>();
    const events = yield* useBufferedChannel<ChatStateEvent>();
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
          yield* commands.send(cmd);
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
  commands: Channel<ChatCommand, void>,
  events: Channel<ChatStateEvent, void>,
  options: ClientToolSessionOptions = {},
): Operation<void> {
  const history: Message[] = [];
  const transcriptState = createTranscriptState(history);
  const currentRequest: {
    owned: { token: symbol; halt: () => Operation<void> } | null;
  } = { owned: null };
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
      ...(options.fetch ? { fetch: options.fetch } : {}),
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

  function* startRequest(
    requestOptions: Pick<StreamChatOptions, "pluginAbort"> = {},
  ): Operation<StreamResult> {
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
          ...requestOptions,
        });
      } catch (error) {
        yield* streamEvents.close();
        if (terminalForwarded) yield* call(waitForTerminalForwarded);
        // RUN_ERROR may follow projected tool-call/error-result events. Persist
        // those mirrored messages before surfacing the request failure so the
        // next turn does not inherit an unexplained hanging tool call.
        syncMessagesFromIndex(history, mirroredState.messages, originalHistoryLength);
        const visiblePartial = mirroredState.streaming.parts
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

  function* haltCurrentRequest(): Operation<void> {
    const owned = currentRequest.owned;
    if (!owned) {
      return;
    }
    currentRequest.owned = null;
    yield* owned.halt();
  }

  function* launchRequest(
    requestOptions: Pick<StreamChatOptions, "pluginAbort"> = {},
    lifecycle: "request" | "cancellation" = "request",
  ): Operation<void> {
    // The request runs as a child task of this session so that destroying the
    // session resource halts any in-flight request (structured teardown) and
    // spawned work inherits session contexts (BaseUrlContext/StreamerContext).
    const token = Symbol(lifecycle);
    const task = yield* spawn(function* (): Operation<StreamResult | undefined> {
      try {
        const result = yield* startRequest(requestOptions);
        options.onTurnSettled?.(result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        yield* sendEvent({ type: "LOCAL_ERROR", message });
        options.onRequestError?.(error);
        return undefined;
      } finally {
        if (currentRequest.owned?.token === token) {
          currentRequest.owned = null;
        }
      }
    });
    currentRequest.owned = { token, halt: () => task.halt() };
    // Lifecycle callbacks observe task settlement (success, failure, or halt)
    // without ever throwing back into the session command loop.
    void Promise.resolve(task)
      .catch(() => undefined)
      .finally(() => {
        try {
          options.onRequestFinished?.();
          if (lifecycle === "cancellation") {
            options.onCancellationSettled?.();
          }
        } catch {
          // Lifecycle callbacks must not surface as unhandled rejections.
        }
      });
  }

  for (const cmd of yield* each(commands)) {
    switch (cmd.type) {
      case "send": {
        if (currentRequest.owned) {
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
          yield* haltCurrentRequest();
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

        // Free-form send supersedes any still-open plugin elicits. Do not
        // serialize these as ordinary `{ action: "cancel" }` responses: that
        // resumes tool business logic and can trigger a terminal model sample.
        // A response-free request lets the handler select its pluginAbort path
        // and continue the replacement user turn in the same activation.
        const supersedingOpenElicits = openElicits.length > 0;
        if (supersedingOpenElicits) {
          for (const elicit of openElicits) {
            if (sentElicitResponseIds.has(elicit.elicitId)) continue;
            sentElicitResponseIds.add(elicit.elicitId);
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

        yield* launchRequest();
        break;
      }

      case "continue": {
        if (currentRequest.owned) {
          yield* haltCurrentRequest();
        }

        yield* launchRequest();
        break;
      }

      case "abort": {
        // Request pipelines share one session event channel and must not run
        // concurrently. Halt/join the client reader first; durable server work
        // survives disconnect and is cancelled by the following plugin-abort
        // request. The dedicated cancellation callback cannot be satisfied by
        // this old request's generic monitor.
        if (currentRequest.owned) {
          yield* haltCurrentRequest();
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

        // Program Runtime cancellation targets the active durable root for the
        // conversation; no fabricated ToolSession identifier crosses the wire.
        yield* launchRequest({ pluginAbort: { reason: "cancelled_by_user" } }, "cancellation");
        break;
      }

      case "reset": {
        if (currentRequest.owned) {
          yield* haltCurrentRequest();
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
          yield* commands.send({ type: "continue" });
        }
        break;
      }
    }

    yield* each.next();
  }
}
