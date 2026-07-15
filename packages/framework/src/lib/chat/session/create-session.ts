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
import { streamChatOnce, type ElicitResponseData } from "./stream-chat.ts";
import { useTransformPipeline } from "./transforms.ts";
import { chatReducer, initialChatState } from "../state/reducer.ts";
import type { ChatState } from "../state/chat-state.ts";
import { StreamerContext, BaseUrlContext } from "./contexts.ts";
import type { ChatPatch } from "../patches/index.ts";
import type { Message } from "../types.ts";
import type { ChatCommand, SessionOptions, Streamer, PatchTransform } from "./options.ts";
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
    const patches = createChannel<ChatPatch, void>();
    const stateSignal = createBufferedStateSignal<ChatState>();

    if (options.baseUrl) {
      yield* BaseUrlContext.set(options.baseUrl);
    }
    if (options.streamer) {
      yield* StreamerContext.set(options.streamer);
    }

    yield* spawn(() => runChatSession(commands, patches, options));

    yield* spawn(function* () {
      let currentState = initialChatState;
      stateSignal.send(currentState);

      for (const patch of yield* each(patches)) {
        currentState = chatReducer(currentState, patch);
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

function createStreamingEndAcknowledger(onForwarded: () => void): PatchTransform {
  return function* (input, output) {
    for (const patch of yield* each(input)) {
      yield* output.send(patch);
      if (patch.type === "streaming_end") {
        onForwarded();
      }
      yield* each.next();
    }
  };
}

function findAssistantToolCallHostMessage(
  history: Message[],
  pendingToolCalls: Array<{ id: string; name: string }>,
): Message | undefined {
  const pendingIds = new Set(pendingToolCalls.map((toolCall) => toolCall.id));
  return [...history]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        message.tool_calls?.some((toolCall) => pendingIds.has(toolCall.id)),
    );
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
  patches: Channel<ChatPatch, void>,
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

  function* sendPatch(patch: ChatPatch): Operation<void> {
    mirroredState = chatReducer(mirroredState, patch);
    yield* patches.send(patch);
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

    for (const patch of durableHistory.patches) {
      yield* sendPatch(patch);
    }
  }

  function* startRequest(): Operation<StreamResult> {
    let streamingEndForwarded = false;
    let streamingEndForwardedResolve: (() => void) | null = null;
    let streamingEndSent = false;

    function waitForStreamingEndForwarded(): Promise<void> {
      if (streamingEndForwarded) return Promise.resolve();
      return new Promise<void>((resolve) => {
        streamingEndForwardedResolve = resolve;
      });
    }

    const streamingEndAcknowledger = createStreamingEndAcknowledger(() => {
      if (!streamingEndForwarded) {
        streamingEndForwarded = true;
        streamingEndForwardedResolve?.();
        streamingEndForwardedResolve = null;
      }
    });
    const mirrorPatchState: PatchTransform = function* (input, output) {
      for (const patch of yield* each(input)) {
        mirroredState = chatReducer(mirroredState, patch);
        yield* output.send(patch);
        yield* each.next();
      }
    };

    const streamPatches = yield* useTransformPipeline(patches, [
      mirrorPatchState,
      ...(options.transforms ?? []),
      streamingEndAcknowledger,
    ]);

    const contextStreamer = yield* StreamerContext.get();
    const streamer = contextStreamer ?? options.streamer ?? defaultStreamer;
    const originalHistoryLength = history.length;
    let result: StreamResult;

    while (true) {
      const elicitResponsesToSend = pendingElicitResponses.splice(0);
      result = yield* streamer([...history], streamPatches, {
        ...options,
        ...(conversationId ? { conversationId } : {}),
        ...(elicitResponsesToSend.length > 0 ? { elicitResponses: elicitResponsesToSend } : {}),
        ...(replayState ? { replayState } : {}),
      });

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

        const assistantToolCallHostMessage = findAssistantToolCallHostMessage(
          history,
          pendingToolCalls,
        );
        if (assistantToolCallHostMessage) {
          yield* sendPatch({
            type: "assistant_message",
            message: assistantToolCallHostMessage,
          });
        }
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
        const assistantMessage = finalAssistantMessage(history, transcriptState, finalContent);
        yield* sendPatch({
          type: "assistant_message",
          message: assistantMessage,
        });
      }
    }

    yield* streamPatches.send({ type: "streaming_end" });
    streamingEndSent = true;
    yield* call(waitForStreamingEndForwarded);
    yield* streamPatches.close();

    if (!streamingEndSent) {
      yield* sendPatch({ type: "streaming_end" });
    }

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
            yield* sendPatch({
              type: "assistant_message",
              message: partialMessage,
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
            yield* sendPatch({
              type: "elicit_response",
              callId: elicit.callId,
              elicitId: elicit.elicitId,
              response: { action: "cancel" },
            });
          }
          openElicits = [];
        }

        const userMessage = appendUserMessage(history, transcriptState, cmd.content);
        const rendered = options.renderer?.(cmd.content);
        yield* sendPatch({
          type: "user_message",
          message: userMessage,
          ...(rendered !== undefined ? { rendered } : {}),
        });
        yield* sendPatch({ type: "streaming_start" });

        currentRequestTask = yield* spawn(function* () {
          try {
            return yield* startRequest();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            yield* sendPatch({ type: "error", message });
            yield* sendPatch({ type: "streaming_end" });
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

        yield* sendPatch({ type: "streaming_start" });
        currentRequestTask = yield* spawn(function* () {
          try {
            return yield* startRequest();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            yield* sendPatch({ type: "error", message });
            yield* sendPatch({ type: "streaming_end" });
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
          yield* sendPatch({
            type: "abort_complete",
            message: partialMessage,
            ...(cmd.partialHtml !== undefined ? { rendered: cmd.partialHtml } : {}),
          });
        } else {
          yield* sendPatch({ type: "streaming_end" });
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
        yield* sendPatch({ type: "reset" });
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

        yield* sendPatch({
          type: "elicit_response",
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
