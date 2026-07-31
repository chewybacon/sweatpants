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
import { useBufferedChannel, useTransformPipeline } from "./transforms.ts";
import { initialChatState } from "../state/chat-state.ts";
import type { ChatState } from "../state/chat-state.ts";
import { StreamerContext, BaseUrlContext } from "./contexts.ts";
import type { ChatStateEvent } from "../state/events.ts";
import type {
  ChatCommand,
  SessionOptions,
  StreamChatOptions,
  Streamer,
  ChatEventTransform,
} from "./options.ts";
import type { ChatTransportReceipt, ChatTurnSettlement } from "./settlement.ts";
import { createChatSessionProjection } from "./projection.ts";
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

    stateSignal.send(initialChatState);
    yield* spawn(() =>
      runChatSession(commands, events, options, (state) => {
        stateSignal.send(state);
      }),
    );

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

export function* runChatSession(
  commands: Channel<ChatCommand, void>,
  events: Channel<ChatStateEvent, void>,
  options: ClientToolSessionOptions = {},
  publishState?: (state: ChatState) => void,
): Operation<void> {
  const turn = createChatSessionProjection(options.conversationId);
  const currentRequest: {
    owned: { token: symbol; halt: () => Operation<void> } | null;
  } = { owned: null };

  function* sendEvent(event: ChatStateEvent): Operation<void> {
    turn.fold(event);
    publishState?.(turn.state);
    yield* events.send(event);
  }

  function* sendEvents(stateEvents: ChatStateEvent[]): Operation<void> {
    for (const event of stateEvents) {
      yield* sendEvent(event);
    }
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

    turn.loadDurableHistory(durableHistory.history, durableHistory.replayState);
    yield* sendEvents(durableHistory.events);
  }

  function* startRequest(
    requestOptions: Pick<StreamChatOptions, "pluginAbort"> = {},
  ): Operation<ChatTurnSettlement> {
    let terminalForwarded = false;
    let terminalForwardedResolve: (() => void) | null = null;

    function waitForTerminalForwarded(): Promise<void> {
      if (terminalForwarded) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        terminalForwardedResolve = resolve;
      });
    }

    const terminalAcknowledger = createRunTerminalAcknowledger(() => {
      if (terminalForwarded) {
        return;
      }
      terminalForwarded = true;
      terminalForwardedResolve?.();
      terminalForwardedResolve = null;
    });
    const projectEventState: ChatEventTransform = function* (input, output) {
      for (const event of yield* each(input)) {
        turn.fold(event);
        publishState?.(turn.state);
        yield* output.send(event);
        yield* each.next();
      }
    };

    const streamEvents = yield* useTransformPipeline(events, [
      ...(options.transforms ?? []),
      projectEventState,
      terminalAcknowledger,
    ]);

    const contextStreamer = yield* StreamerContext.get();
    const streamer = contextStreamer ?? options.streamer ?? defaultStreamer;
    const request = turn.beginTurnRequest();
    let receipt: ChatTransportReceipt;

    try {
      receipt = yield* streamer([...turn.history], streamEvents, {
        ...options,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.elicitResponses.length > 0 ? { elicitResponses: request.elicitResponses } : {}),
        ...(request.replayState ? { replayState: request.replayState } : {}),
        ...requestOptions,
      });
      turn.recordConversationId(receipt);

      // Closing drains every queued event through transforms. Check the terminal
      // invariant only after the drain so custom streamers cannot deadlock us by
      // returning without RUN_FINISHED/RUN_ERROR.
      yield* streamEvents.close();
      if (!terminalForwarded) {
        throw new Error("Streamer returned without a terminal AG-UI event");
      }
      yield* call(waitForTerminalForwarded);
      return turn.settle();
    } catch (error) {
      try {
        yield* streamEvents.close();
      } catch {
        // Preserve the first transport/projection failure.
      }
      if (terminalForwarded) {
        yield* call(waitForTerminalForwarded);
      }
      turn.fail();
      throw error;
    }
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
    const task = yield* spawn(function* (): Operation<ChatTurnSettlement | undefined> {
      try {
        const settlement = yield* startRequest(requestOptions);
        options.onTurnSettled?.(settlement);
        return settlement;
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
        // An interrupted partial is only meaningful when a request was actually
        // in flight; otherwise there is nothing being superseded.
        const supersededPartial = currentRequest.owned ? cmd.partialContent : undefined;
        if (currentRequest.owned) {
          yield* haltCurrentRequest();
        }
        yield* sendEvents(turn.send(cmd.content, supersededPartial));
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

        yield* sendEvents(
          turn.abort(cmd.partialContent, {
            preservePartial: options.preservePartialOnAbort ?? true,
            suffix: options.abortSuffix ?? "",
          }),
        );

        // Program Runtime cancellation targets the active durable root for the
        // conversation; no fabricated ToolSession identifier crosses the wire.
        yield* launchRequest({ pluginAbort: { reason: "cancelled_by_user" } }, "cancellation");
        break;
      }

      case "reset": {
        if (currentRequest.owned) {
          yield* haltCurrentRequest();
        }
        yield* sendEvents(turn.reset());
        break;
      }

      case "elicit_response": {
        const stateEvents = turn.elicitResponse({
          sessionId: cmd.sessionId,
          callId: cmd.callId,
          ...(cmd.toolName ? { toolName: cmd.toolName } : {}),
          ...(cmd.ref ? { ref: cmd.ref } : {}),
          elicitId: cmd.elicitId,
          completion: cmd.completion,
          ...(cmd.trace ? { trace: cmd.trace } : {}),
        });
        if (!stateEvents) {
          break;
        }
        yield* sendEvents(stateEvents);
        if (cmd.autoContinue !== false) {
          yield* commands.send({ type: "continue" });
        }
        break;
      }
    }

    yield* each.next();
  }
}
