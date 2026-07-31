import {
  call,
  createSignal,
  each,
  resource,
  spawn,
  useScope,
  type Channel,
  type Operation,
  type Stream,
  type Subscription,
} from "effection";
import type { ChatState } from "../state/chat-state.ts";
import { initialChatState } from "../state/chat-state.ts";
import type { ChatStateEvent } from "../state/events.ts";
import { BaseUrlContext } from "./contexts.ts";
import { readDurableHistory } from "./durable-history.ts";
import {
  createInitialSessionProjectionState,
  transitionSession,
  type ChatRequestPlan,
  type SessionInput,
  type SessionOutput,
  type SessionProjectionState,
} from "./machine.ts";
import { publicChatState } from "./projection.ts";
import type { ChatTurnFailure } from "./settlement.ts";
import type { ChatCommand, SessionOptions, ChatEventTransform } from "./options.ts";
import { ChatSessionRuntimeApi } from "./runtime-api.ts";
import { useBufferedChannel, useTransformPipeline } from "./transforms.ts";

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

interface InputEnvelope {
  readonly input: SessionInput;
  readonly resolve: () => void;
}

function failureFromUnknown(error: unknown): ChatTurnFailure {
  if (error instanceof Error) {
    return { message: error.message, cause: error };
  }
  return {
    message: "Unknown chat request failure",
    ...(error !== undefined ? { cause: error } : {}),
  };
}

export interface ChatSession {
  state: Stream<ChatState, void>;
  dispatch: (command: ChatCommand) => void;
}

export function createChatSession(options: SessionOptions = {}): Operation<ChatSession> {
  return resource(function* (provide) {
    const scope = yield* useScope();
    const commands = yield* useBufferedChannel<ChatCommand>();
    const events = yield* useBufferedChannel<ChatStateEvent>();
    const stateSignal = createBufferedStateSignal<ChatState>();

    if (options.baseUrl) {
      yield* BaseUrlContext.set(options.baseUrl);
    }
    stateSignal.send(initialChatState);
    // The public constructor does not expose the transformed-event channel, so
    // drain it while the machine publishes the authored ChatState separately.
    yield* spawn(function* () {
      for (const _event of yield* each(events)) {
        yield* each.next();
      }
    });
    yield* spawn(() =>
      runChatSession(commands, events, options, (state) => {
        stateSignal.send(state);
      }),
    );

    yield* provide({
      state: yield* stateSignal.subscribe(),
      dispatch: (command) =>
        scope.run(function* () {
          yield* commands.send(command);
        }),
    });
  });
}

export function* runChatSession(
  commands: Channel<ChatCommand, void>,
  events: Channel<ChatStateEvent, void>,
  options: SessionOptions = {},
  publishState?: (state: ChatState) => void,
): Operation<void> {
  const inputs = yield* useBufferedChannel<InputEnvelope>();
  let state: SessionProjectionState = createInitialSessionProjectionState(options.conversationId);
  const currentRequest: {
    owned: { token: symbol; halt: () => Operation<void> } | null;
  } = { owned: null };

  function* dispatchInput(input: SessionInput): Operation<void> {
    let resolve!: () => void;
    const processed = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    void processed.catch(() => undefined);
    yield* inputs.send({ input, resolve });
    yield* call(() => processed);
  }

  function* haltCurrentRequest(): Operation<void> {
    const owned = currentRequest.owned;
    if (!owned) return;
    currentRequest.owned = null;
    yield* owned.halt();
  }

  function dispatchEventTransform(requestId: string): ChatEventTransform {
    return function* (input, output) {
      for (const event of yield* each(input)) {
        const observedAt = yield* ChatSessionRuntimeApi.operations.now();
        yield* dispatchInput({ type: "stream-event", requestId, event, observedAt });
        yield* output.send(event);
        yield* each.next();
      }
    };
  }

  function* launchRequest(plan: ChatRequestPlan): Operation<void> {
    const token = Symbol(plan.lifecycle);
    const task = yield* spawn(function* () {
      const streamEvents = yield* useTransformPipeline(events, [
        ...(options.transforms ?? []),
        dispatchEventTransform(plan.requestId),
      ]);
      try {
        const receipt = yield* ChatSessionRuntimeApi.operations.runRequest(
          plan,
          streamEvents,
          options,
        );
        yield* streamEvents.close();
        yield* dispatchInput({
          type: "transport-drained",
          requestId: plan.requestId,
          receipt,
          observedAt: yield* ChatSessionRuntimeApi.operations.now(),
        });
      } catch (error) {
        try {
          yield* streamEvents.close();
        } catch {
          // Preserve the first transport or projection failure.
        }
        yield* dispatchInput({
          type: "transport-failed",
          requestId: plan.requestId,
          failure: failureFromUnknown(error),
          observedAt: yield* ChatSessionRuntimeApi.operations.now(),
        });
      } finally {
        if (currentRequest.owned?.token === token) {
          currentRequest.owned = null;
        }
      }
    });
    currentRequest.owned = { token, halt: () => task.halt() };
    void Promise.resolve(task)
      .catch(() => undefined)
      .finally(() => {
        try {
          options.onRequestFinished?.();
          if (plan.lifecycle === "cancellation") {
            options.onCancellationSettled?.();
          }
        } catch {
          // Lifecycle callbacks cannot escape the structured task boundary.
        }
      });
  }

  function notifyFailure(failure: ChatTurnFailure): void {
    try {
      options.onRequestError?.(
        new Error(
          failure.message,
          failure.cause === undefined ? undefined : { cause: failure.cause },
        ),
      );
    } catch {
      // Observation callbacks do not participate in session authority.
    }
  }

  function notifySettlement(output: Extract<SessionOutput, { type: "turn-settled" }>): void {
    try {
      options.onTurnSettled?.(output.settlement);
    } catch {
      // Observation callbacks do not participate in session authority.
    }
  }

  function* interpret(output: SessionOutput): Operation<void> {
    switch (output.type) {
      case "cancel-request":
        yield* haltCurrentRequest();
        return;
      case "start-request":
        yield* launchRequest(output.plan);
        return;
      case "request-failed":
        notifyFailure(output.failure);
        return;
      case "turn-settled":
        notifySettlement(output);
        return;
    }
  }

  yield* spawn(function* () {
    for (const envelope of yield* each(inputs)) {
      try {
        const transition = transitionSession(state, envelope.input);
        state = transition.state;
        publishState?.(publicChatState(state.view));
        for (const output of transition.outputs) {
          yield* interpret(output);
        }
        envelope.resolve();
      } catch (error) {
        notifyFailure(failureFromUnknown(error));
        envelope.resolve();
      }
      yield* each.next();
    }
  });

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
    yield* dispatchInput({
      type: "hydrate",
      history: durableHistory.history,
      events: durableHistory.events,
      ...(durableHistory.replayState ? { replayState: durableHistory.replayState } : {}),
      observedAt: yield* ChatSessionRuntimeApi.operations.now(),
    });
  }

  for (const command of yield* each(commands)) {
    const requestId =
      command.type === "reset" ? undefined : yield* ChatSessionRuntimeApi.operations.createId();
    const abortMessageId =
      command.type === "abort" ? yield* ChatSessionRuntimeApi.operations.createId() : undefined;
    yield* dispatchInput({
      type: "command",
      command,
      ...(requestId ? { requestId } : {}),
      ...(abortMessageId ? { abortMessageId } : {}),
      preservePartialOnAbort: options.preservePartialOnAbort ?? true,
      abortSuffix: options.abortSuffix ?? "",
      observedAt: yield* ChatSessionRuntimeApi.operations.now(),
    });
    yield* each.next();
  }
}
