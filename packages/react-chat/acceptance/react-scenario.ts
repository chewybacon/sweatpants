import { useEffect } from "react";
import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { call, resource, type Operation } from "effection";
import type { ScenarioContext } from "@sweatpants/test-rig";
import {
  useChat,
  type ChatMessage,
  type UseChatOptions,
  type UseChatReturn,
} from "../src/index.ts";
import type { ToolEmissionState } from "../src/types.ts";

type StreamEntry = Parameters<NonNullable<UseChatOptions["onStreamEvent"]>>[0];

interface Waiter<T> {
  select(value: UseChatReturn): T | undefined;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export interface ReactMessageExpectation {
  role?: ChatMessage["role"];
  containing?: string;
}

export interface ReactMessageHandle {
  readonly message: ChatMessage;
  readonly role: ChatMessage["role"];
  readonly text: string;
  readonly html: string;
}

export interface ReactEmissionExpectation {
  toolName?: string;
  componentKey?: string;
  status?: ToolEmissionState["status"];
}

export interface ReactEmissionHandle {
  readonly callId: string;
  readonly id: string;
  readonly toolName: string;
  readonly componentKey?: string;
  readonly props?: Record<string, unknown>;
  readonly status: ToolEmissionState["status"];
  respond(value: unknown): Operation<void>;
}

export interface ReactChatHandle {
  send(content: string): Operation<void>;
  abort(): Operation<void>;
  reset(): Operation<void>;
  /** Wait for a React-observed active run to return to terminal state. */
  settled(): Operation<UseChatReturn>;
  snapshot(assertion?: (chat: UseChatReturn) => void): Operation<UseChatReturn>;
  message(expectation: ReactMessageExpectation): Operation<ReactMessageHandle>;
  emission(expectation: ReactEmissionExpectation): Operation<ReactEmissionHandle>;
  /** Passive raw AG-UI evidence; React-visible barriers drive choreography. */
  events(): readonly StreamEntry[];
  unmount(): Operation<void>;
}

function projectedMessage(message: ChatMessage): ReactMessageHandle {
  const textParts = message.parts.filter(
    (part): part is Extract<ChatMessage["parts"][number], { type: "text" }> => part.type === "text",
  );
  return {
    message,
    role: message.role,
    text: textParts.map((part) => part.content).join(""),
    html: textParts.map((part) => part.rendered).join(""),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Mount the real React hooks and expose semantic, buffered state barriers. */
export function mountReactChat(
  scenario: ScenarioContext,
  options: UseChatOptions = {},
  timeoutMs = 10_000,
): Operation<ReactChatHandle> {
  return resource(function* (provide) {
    const snapshots: UseChatReturn[] = [];
    const waiters: Waiter<unknown>[] = [];
    const streamEvents: StreamEntry[] = [];
    let closed = false;
    let rendered: RenderHookResult<UseChatReturn, unknown> | undefined;

    const close = (): void => {
      if (closed) return;
      closed = true;
      const error = new Error("React chat harness is closed");
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      rendered?.unmount();
      rendered = undefined;
    };

    const assertOpen = (): void => {
      if (closed) throw new Error("React chat harness is closed");
    };

    const timeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`react_barrier_timeout: ${label} after ${timeoutMs}ms`)),
          timeoutMs,
        );
        promise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
            return undefined;
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
            return undefined;
          },
        );
      });

    const publish = (chat: UseChatReturn): void => {
      snapshots.push(chat);
      for (const waiter of [...waiters]) {
        try {
          const selected = waiter.select(chat);
          if (selected === undefined) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(selected);
        } catch (error) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.reject(error);
        }
      }
    };

    const originalStreamObserver = options.onStreamEvent;
    const hookOptions: UseChatOptions = {
      ...options,
      fetch: scenario.transport.fetch,
      onStreamEvent(entry) {
        streamEvents.push(entry);
        originalStreamObserver?.(entry);
      },
    };

    rendered = renderHook(() => {
      const chat = useChat(hookOptions);
      useEffect(() => publish(chat), [chat]);
      return chat;
    });

    function waitFor<T>(label: string, select: (chat: UseChatReturn) => T | undefined): Promise<T> {
      if (closed) return Promise.reject(new Error("React chat harness is closed"));
      for (let index = snapshots.length - 1; index >= 0; index -= 1) {
        const selected = select(snapshots[index]!);
        if (selected !== undefined) return Promise.resolve(selected);
      }
      return timeout(
        new Promise<T>((resolve, reject) => {
          waiters.push({ select, resolve, reject } as Waiter<unknown>);
        }),
        label,
      );
    }

    function emissionHandle(chat: UseChatReturn, emission: ToolEmissionState): ReactEmissionHandle {
      const payload = record(emission.payload);
      const props = record(payload?.["props"]);
      const componentKey =
        typeof payload?.["componentKey"] === "string" ? payload["componentKey"] : undefined;
      return {
        callId: emission.callId,
        id: emission.id,
        toolName: emission.toolName,
        ...(componentKey ? { componentKey } : {}),
        ...(props ? { props } : {}),
        status: emission.status,
        *respond(value) {
          assertOpen();
          yield* call(() =>
            act(async () => {
              chat.session.respondToEmission(emission.callId, emission.id, value);
            }),
          );
        },
      };
    }

    const handle: ReactChatHandle = {
      *send(content) {
        assertOpen();
        yield* call(() => act(async () => rendered!.result.current.send(content)));
      },
      *abort() {
        assertOpen();
        yield* call(() => act(async () => rendered!.result.current.abort()));
      },
      *reset() {
        assertOpen();
        yield* call(() => act(async () => rendered!.result.current.reset()));
      },
      *settled() {
        let observedActive = false;
        let terminal: UseChatReturn | undefined;
        for (const snapshot of snapshots) {
          if (snapshot.isStreaming || snapshot.session.state.activeRun !== null) {
            observedActive = true;
          } else if (observedActive) {
            terminal = snapshot;
          }
        }
        if (terminal) return terminal;
        return yield* call(() =>
          waitFor("React run settlement", (chat) => {
            if (chat.isStreaming || chat.session.state.activeRun !== null) {
              observedActive = true;
              return undefined;
            }
            return observedActive ? chat : undefined;
          }),
        );
      },
      *snapshot(assertion) {
        const chat = yield* call(() => waitFor("hook snapshot", (value) => value));
        assertion?.(chat);
        return chat;
      },
      *message(expectation) {
        return yield* call(() =>
          waitFor("projected message", (chat) => {
            for (const message of chat.messages) {
              const projected = projectedMessage(message);
              if (expectation.role !== undefined && projected.role !== expectation.role) continue;
              if (
                expectation.containing !== undefined &&
                !projected.text.includes(expectation.containing)
              ) {
                continue;
              }
              return projected;
            }
            return undefined;
          }),
        );
      },
      *emission(expectation) {
        return yield* call(() =>
          waitFor("plugin emission", (chat) => {
            for (const tracking of chat.session.toolEmissions) {
              for (const emission of tracking.emissions) {
                const payload = record(emission.payload);
                if (expectation.toolName && emission.toolName !== expectation.toolName) continue;
                if (
                  expectation.componentKey &&
                  payload?.["componentKey"] !== expectation.componentKey
                ) {
                  continue;
                }
                if (expectation.status && emission.status !== expectation.status) continue;
                return emissionHandle(chat, emission);
              }
            }
            return undefined;
          }),
        );
      },
      events: () => Object.freeze([...streamEvents]),
      *unmount() {
        close();
      },
    };

    try {
      yield* provide(handle);
    } finally {
      close();
    }
  });
}
