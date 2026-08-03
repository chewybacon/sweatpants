import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { call, resource, type Operation } from "effection";
import type { ScenarioContext } from "@sweatpants/test-rig";
import {
  createChatClient,
  useChat,
  type ChatMessage,
  type ReactChatClient,
  type ReactRenderPart,
  type UseChatOptions,
  type UseChatResult,
} from "../src/index.ts";
import { useEffect } from "react";

interface Waiter<T> {
  select(value: UseChatResult): T | undefined;
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

export interface ReactRenderExpectation {
  toolName?: string;
  componentKey?: string;
  status?: "pending" | "complete";
}

export interface ReactRenderHandle {
  readonly callId: string;
  readonly id: string;
  readonly toolName: string;
  readonly componentKey?: string;
  readonly props?: Record<string, unknown>;
  readonly status: "pending" | "complete";
  respond(value: unknown): Operation<void>;
}

export interface ReactChatHandle {
  send(content: string): Operation<void>;
  abort(): Operation<void>;
  reset(): Operation<void>;
  settled(): Operation<UseChatResult>;
  snapshot(assertion?: (chat: UseChatResult) => void): Operation<UseChatResult>;
  message(expectation: ReactMessageExpectation): Operation<ReactMessageHandle>;
  render(expectation: ReactRenderExpectation): Operation<ReactRenderHandle>;
  events(): readonly unknown[];
  unmount(): Operation<void>;
}

const clientsByScenario = new WeakMap<object, Map<string, ReactChatClient>>();

function getClient(scenario: ScenarioContext, options: UseChatOptions): ReactChatClient {
  if ("client" in options && options.client) return options.client;
  const threadId = options.threadId;
  let clients = clientsByScenario.get(scenario as object);
  if (!clients) {
    clients = new Map();
    clientsByScenario.set(scenario as object, clients);
  }
  const existing = clients.get(threadId);
  if (existing) return existing;
  const created = createChatClient({
    threadId,
    transport: { http: { fetch: scenario.transport.fetch } },
    ...(options.pipeline !== undefined ? { pipeline: options.pipeline } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
  });
  clients.set(threadId, created);
  return created;
}

function projectedMessage(message: ChatMessage): ReactMessageHandle {
  const textParts = message.parts.filter(
    (part): part is Extract<ChatMessage["parts"][number], { type: "text" }> => part.type === "text",
  );
  return {
    message,
    role: message.role,
    text: textParts.map((part) => part.text).join(""),
    html:
      textParts.map((part) => (part.rendered !== part.text ? part.rendered : "")).join("") ||
      textParts.map((part) => part.rendered).join(""),
  };
}

function allRenderParts(messages: readonly ChatMessage[]): ReactRenderPart[] {
  const output: ReactRenderPart[] = [];
  const visit = (parts: readonly ChatMessage["parts"][number][]): void => {
    for (const part of parts) {
      if (part.type === "render") output.push(part);
      else if (part.type === "message") visit(part.message.parts);
      else if (part.type === "tool-call" || part.type === "activity" || part.type === "elicit")
        visit(part.parts);
    }
  };
  for (const message of messages) visit(message.parts);
  return output;
}

function findElicit(
  messages: readonly ChatMessage[],
  elicitId: string,
): Extract<ChatMessage["parts"][number], { type: "elicit" }> | undefined {
  let found: Extract<ChatMessage["parts"][number], { type: "elicit" }> | undefined;
  const visit = (parts: readonly ChatMessage["parts"][number][]): void => {
    for (const part of parts) {
      if (part.type === "elicit" && part.elicitId === elicitId) found = part;
      else if (part.type === "message") visit(part.message.parts);
      else if (part.type === "tool-call" || part.type === "activity" || part.type === "elicit")
        visit(part.parts);
    }
  };
  for (const message of messages) visit(message.parts);
  return found;
}

/** Mounts the real thin React adapter around one externally owned client. */
export function mountReactChat(
  scenario: ScenarioContext,
  options: Exclude<UseChatOptions, { readonly client: ReactChatClient }> & {
    readonly threadId: string;
  },
  timeoutMs = 10_000,
): Operation<ReactChatHandle> {
  return resource(function* (provide) {
    const client = getClient(scenario, options);
    const snapshots: UseChatResult[] = [];
    const waiters: Waiter<unknown>[] = [];
    let closed = false;
    let rendered: RenderHookResult<UseChatResult, unknown> | undefined;

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
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    const publish = (chat: UseChatResult): void => {
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

    rendered = renderHook(() => {
      const chat = useChat({ client });
      useEffect(() => publish(chat), [chat]);
      return chat;
    });

    function waitFor<T>(label: string, select: (chat: UseChatResult) => T | undefined): Promise<T> {
      if (closed) return Promise.reject(new Error("React chat harness is closed"));
      for (let index = snapshots.length - 1; index >= 0; index -= 1) {
        const selected = select(snapshots[index]!);
        if (selected !== undefined) return Promise.resolve(selected);
      }
      return timeout(
        new Promise<T>((resolve, reject) =>
          waiters.push({ select, resolve, reject } as Waiter<unknown>),
        ),
        label,
      );
    }

    const handle: ReactChatHandle = {
      *send(content) {
        assertOpen();
        yield* call(() =>
          act(() => {
            void rendered!.result.current.sendMessage({ text: content });
          }),
        );
        yield* call(() =>
          waitFor("submitted", (chat) =>
            chat.status === "submitted" || chat.status === "streaming" ? chat : undefined,
          ),
        );
      },
      *abort() {
        assertOpen();
        yield* call(() =>
          act(async () => {
            await rendered!.result.current.stop();
          }),
        );
      },
      *reset() {
        assertOpen();
        yield* call(() => act(() => rendered!.result.current.setMessages([])));
      },
      *settled() {
        let observedActive = false;
        const complete = (chat: UseChatResult): boolean =>
          (observedActive &&
            (chat.status === "ready" || chat.status === "error") &&
            !JSON.stringify(chat.messages).includes('"type":"elicit"')) ||
          (observedActive &&
            (chat.status === "ready" || chat.status === "error") &&
            !JSON.stringify(chat.messages).includes('"state":"pending"'));
        for (const chat of snapshots) {
          if (chat.status === "submitted" || chat.status === "streaming") observedActive = true;
          else if (complete(chat)) return chat;
        }
        return yield* call(() =>
          waitFor("React run settlement", (chat) => {
            if (chat.status === "submitted" || chat.status === "streaming") {
              observedActive = true;
              return undefined;
            }
            return complete(chat) ? chat : undefined;
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
            for (const message of [...chat.messages].reverse()) {
              const projected = projectedMessage(message);
              if (expectation.role !== undefined && projected.role !== expectation.role) continue;
              if (
                expectation.containing !== undefined &&
                !projected.text.includes(expectation.containing)
              )
                continue;
              return projected;
            }
            return undefined;
          }),
        );
      },
      *render(expectation) {
        return yield* call(() =>
          waitFor("local render", (chat) => {
            for (const render of allRenderParts(chat.messages)) {
              const owner = findElicit(chat.messages, render.parentElicitId);
              const element = render.node as {
                readonly type?: { readonly displayName?: string; readonly name?: string };
                readonly props?: Record<string, unknown>;
              };
              const component = element.type as
                | { readonly displayName?: string; readonly name?: string }
                | undefined;
              const componentKey = component?.displayName ?? component?.name;
              const status = render.state === "pending" ? "pending" : "complete";
              if (expectation.status && expectation.status !== status) continue;
              if (expectation.componentKey && expectation.componentKey !== componentKey) continue;
              if (expectation.toolName && owner === undefined) continue;
              return {
                callId: owner?.elicitId ?? "",
                id: render.id,
                toolName: owner?.key ?? "",
                ...(componentKey ? { componentKey } : {}),
                ...(element.props !== undefined ? { props: element.props } : {}),
                status,
                *respond(value: unknown) {
                  assertOpen();
                  const respond = element.props?.["onRespond"];
                  if (typeof respond !== "function")
                    throw new Error("Prepared render part has no responder");
                  yield* call(() => act(() => (respond as (value: unknown) => void)(value)));
                },
              } satisfies ReactRenderHandle;
            }
            return undefined;
          }),
        );
      },
      events: () => Object.freeze([]),
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
