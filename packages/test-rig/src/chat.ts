import { EventType } from "@ag-ui/core";
import { call, type Operation } from "effection";
import type { StreamOptions } from "@sweatpants/model-provider";
import { assertJson } from "@sweatpants/foundation";
import {
  createChatClient,
  type ChatClient,
  type ChatEventMiddleware,
  type ChatFetch as FrameworkChatFetch,
  type ChatInteractionCompletion,
  type ChatInteractionRequest,
  type ChatInteractionRuntime,
  type ChatUISnapshot,
  type AGUIEvent,
  type UserMessageInput,
} from "@sweatpants/chat-client";
export type { ChatUISnapshot } from "@sweatpants/chat-client";

export type ChatFetch = FrameworkChatFetch;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve(value) {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    },
    reject(error) {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    },
  };
}

export interface ConversationOptions {
  conversationId?: string;
  /** Test-rig-only hydration mode used when reopening a durable conversation. */
  reconnectOnOpen?: boolean;
  systemPrompt?: string;
  initialToolChoice?: StreamOptions["toolChoice"];
  streamOptions?: StreamOptions;
}

export interface TextDeltaBarrier {
  readonly delta: string;
  readonly messageId?: string;
}

export interface ElicitBarrier {
  readonly key: string;
  readonly elicitId: string;
  readonly bindingId: string;
  readonly toolName: string;
  readonly callId: string;
  readonly placement: ChatInteractionRequest["placement"];
  readonly context: unknown;
  accept(content?: unknown): Promise<void>;
  decline(): Promise<void>;
  cancel(): Promise<void>;
}

export interface TurnTranscript {
  readonly events: readonly AGUIEvent[];
  readonly text: string;
  readonly outcome: "success" | "error" | "interrupt";
}

export interface ConversationTranscript {
  readonly conversationId: string;
  readonly events: readonly AGUIEvent[];
  readonly text: string;
}

export interface TurnHandle {
  expectTextDelta(
    expectation: string | RegExp | ((delta: string) => void),
  ): Promise<TextDeltaBarrier>;
  expectElicit(key: string): Promise<ElicitBarrier>;
  snapshot(): ChatUISnapshot;
  expectSnapshot(predicate: (snapshot: ChatUISnapshot) => boolean): Promise<ChatUISnapshot>;
  cancel(): Promise<void>;
  complete(): Promise<TurnTranscript>;
}

export interface ConversationHandle {
  readonly conversationId: string;
  snapshot(): ChatUISnapshot;
  /** Send one message using the exact ChatClient.sendMessage input contract. */
  send(message: UserMessageInput): TurnHandle;
  /** Cancel-on-send using the same ChatClient.sendMessage input contract. */
  supersede(message: UserMessageInput): TurnHandle;
  /** Recreate the headless client while retaining durable conversation identity. */
  reopen(): Promise<ConversationHandle>;
  /** Attach a new turn handle to one durable elicitation recovered by reopen(). */
  resumePendingElicit(key: string): TurnHandle;
  transcript(): ConversationTranscript;
}

export interface ChatHandle {
  conversation(options?: ConversationOptions): ConversationHandle;
}

function matchesDelta(
  expectation: string | RegExp | ((delta: string) => void),
  delta: string,
): boolean {
  if (typeof expectation === "string") {
    return delta === expectation || delta.includes(expectation);
  }
  if (expectation instanceof RegExp) {
    return expectation.test(delta);
  }
  expectation(delta);
  return true;
}

function textFromEvents(events: readonly AGUIEvent[]): string {
  return events
    .filter(
      (event): event is Extract<AGUIEvent, { type: EventType.TEXT_MESSAGE_CONTENT }> =>
        event.type === EventType.TEXT_MESSAGE_CONTENT,
    )
    .map((event) => event.delta)
    .join("");
}

export interface CreateChatRuntimeOptions {
  fetch: ChatFetch;
  baseUrl?: string;
  barrierTimeoutMs: number;
  onPoison?: (error: Error) => Error;
  getRootFailure?: () => Error | undefined;
}

interface OwnedConversation {
  handle: ConversationHandle;
  readonly ready: Promise<void>;
  verify(): void;
  poison(error: Error): void;
  close(): Promise<void>;
}

export interface ChatRuntime {
  readonly handle: ChatHandle;
  verify(): void;
  poison(error: Error): void;
  close(): Promise<void>;
}

function requestOptionsFetch(
  fetch: ChatFetch,
  conversationId: string,
  options: ConversationOptions,
): ChatFetch {
  return async (input, init) => {
    if ((init?.method === undefined || init.method === "POST") && typeof init?.body === "string") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        return fetch(input, init);
      }
      const nativeChatRequest =
        typeof body["clientId"] === "string" && typeof body["conversationId"] === "string";
      if (nativeChatRequest) {
        body["conversationId"] = conversationId;
        const command = body["command"];
        if (command !== null && typeof command === "object" && !Array.isArray(command)) {
          if (options.systemPrompt !== undefined) {
            body["systemPrompt"] = options.systemPrompt;
          }
          if (options.initialToolChoice !== undefined) {
            body["initialToolChoice"] = options.initialToolChoice;
          }
          if (options.streamOptions !== undefined) {
            body["streamOptions"] = options.streamOptions;
          }
        }
        return fetch(input, { ...init, body: JSON.stringify(body) });
      }
    }
    return fetch(input, init);
  };
}

export function createChatRuntime(options: CreateChatRuntimeOptions): ChatRuntime {
  const conversations = new Map<string, OwnedConversation>();

  const chatHandle: ChatHandle = {
    conversation(conversationOptions: ConversationOptions = {}): ConversationHandle {
      const conversationId = conversationOptions.conversationId ?? crypto.randomUUID();
      const existing = conversations.get(conversationId);
      if (existing) {
        return existing.handle;
      }

      const cumulativeEvents: AGUIEvent[] = [];
      let activeTurn: { id: string; reject(error: unknown): void } | undefined;
      let activeTurnEvents: AGUIEvent[] | undefined;
      let turnSettled: Deferred<TurnTranscript> | undefined;
      let closed = false;
      const pendingDeltas: Array<{
        expectation: string | RegExp | ((delta: string) => void);
        wait: Deferred<TextDeltaBarrier>;
      }> = [];
      const pendingSnapshots: Array<{
        turnId: string;
        predicate: (snapshot: ChatUISnapshot) => boolean;
        wait: Deferred<ChatUISnapshot>;
      }> = [];
      const pendingElicits: ElicitBarrier[] = [];
      const elicitWaiters: Array<{ key: string; wait: Deferred<ElicitBarrier> }> = [];
      const elicitationBarriers = new Map<string, ElicitBarrier>();
      const respondedElicits = new Set<string>();
      let terminalSuccessPending = false;
      let pendingRunError: Error | undefined;
      let cancellationInProgress = false;
      let completionHandler:
        | ((request: ChatInteractionRequest, completion: ChatInteractionCompletion) => void)
        | undefined;

      function withBarrierTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => {
            const error = new Error(
              `barrier_timeout: ${label} after ${options.barrierTimeoutMs}ms`,
            );
            reject(options.onPoison?.(error) ?? error);
          }, options.barrierTimeoutMs);
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
      }

      function assertOpen(): void {
        const root = options.getRootFailure?.();
        if (root) {
          throw root;
        }
        if (closed) {
          throw new Error("Conversation is closed");
        }
      }

      function failTurn(error: unknown): void {
        turnSettled?.reject(error);
        for (const waiter of pendingDeltas.splice(0)) {
          waiter.wait.reject(error);
        }
        for (const waiter of elicitWaiters.splice(0)) {
          waiter.wait.reject(error);
        }
        for (const waiter of pendingSnapshots.splice(0)) {
          waiter.wait.reject(error);
        }
        activeTurn?.reject(error);
        activeTurn = undefined;
        activeTurnEvents = undefined;
        turnSettled = undefined;
      }

      function settleTurn(): void {
        if (!turnSettled || !activeTurnEvents) {
          return;
        }
        const events = activeTurnEvents;
        for (const waiter of pendingDeltas.splice(0)) {
          waiter.wait.reject(new Error("Turn completed before the expected text delta"));
        }
        for (const waiter of elicitWaiters.splice(0)) {
          waiter.wait.reject(new Error("Turn completed before the expected elicit barrier"));
        }
        const settledTurnId = activeTurn?.id;
        for (let index = pendingSnapshots.length - 1; index >= 0; index -= 1) {
          if (pendingSnapshots[index]?.turnId === settledTurnId) {
            pendingSnapshots[index]!.wait.reject(
              new Error("Turn completed before the expected snapshot"),
            );
            pendingSnapshots.splice(index, 1);
          }
        }
        turnSettled.resolve({
          events: Object.freeze([...events]),
          text: textFromEvents(events),
          outcome: "success",
        });
        activeTurn = undefined;
        activeTurnEvents = undefined;
        turnSettled = undefined;
      }

      function resolveDeltaWaiters(delta: string, messageId?: string): void {
        for (let index = pendingDeltas.length - 1; index >= 0; index -= 1) {
          const waiter = pendingDeltas[index]!;
          try {
            if (!matchesDelta(waiter.expectation, delta)) {
              continue;
            }
            pendingDeltas.splice(index, 1);
            waiter.wait.resolve({ delta, ...(messageId ? { messageId } : {}) });
          } catch (error) {
            pendingDeltas.splice(index, 1);
            waiter.wait.reject(error);
          }
        }
      }

      function resolveSnapshotWaiters(snapshot: ChatUISnapshot): void {
        for (let index = pendingSnapshots.length - 1; index >= 0; index -= 1) {
          const waiter = pendingSnapshots[index]!;
          try {
            if (!waiter.predicate(snapshot)) {
              continue;
            }
            pendingSnapshots.splice(index, 1);
            waiter.wait.resolve(snapshot);
          } catch (error) {
            pendingSnapshots.splice(index, 1);
            waiter.wait.reject(error);
          }
        }
      }

      function publishElicit(request: ChatInteractionRequest): void {
        if (respondedElicits.has(request.elicitId) || elicitationBarriers.has(request.elicitId)) {
          return;
        }
        let answered = false;
        const answer = async (completion: ChatInteractionCompletion): Promise<void> => {
          assertOpen();
          if (answered || respondedElicits.has(request.elicitId)) {
            throw new Error(`Elicit ${request.key} was already answered`);
          }
          answered = true;
          respondedElicits.add(request.elicitId);
          if (!completionHandler) {
            throw new Error("Test interaction runtime has no completion handler");
          }
          completionHandler(request, completion);
        };
        const barrier: ElicitBarrier = {
          key: request.key,
          elicitId: request.elicitId,
          bindingId: request.bindingId,
          toolName: request.toolName,
          callId: request.callId,
          placement: request.placement,
          context: request.context,
          accept: (content) => answer({ action: "accept", content: assertJson(content ?? {}) }),
          decline: () => answer({ action: "decline" }),
          cancel: () => answer({ action: "cancel" }),
        };
        elicitationBarriers.set(request.elicitId, barrier);
        const matchingWaiters = elicitWaiters.filter((waiter) => waiter.key === request.key);
        if (matchingWaiters.length === 0) {
          pendingElicits.push(barrier);
          return;
        }
        for (const waiter of matchingWaiters) {
          elicitWaiters.splice(elicitWaiters.indexOf(waiter), 1);
          waiter.wait.resolve(barrier);
        }
      }

      function forgetElicit(elicitId: string): void {
        elicitationBarriers.delete(elicitId);
        for (let index = pendingElicits.length - 1; index >= 0; index -= 1) {
          if (pendingElicits[index]!.elicitId === elicitId) {
            pendingElicits.splice(index, 1);
          }
        }
      }

      function hasPendingElicit(key: string): boolean {
        return (
          pendingElicits.some((barrier) => barrier.key === key) ||
          [...elicitationBarriers.values()].some(
            (barrier) => barrier.key === key && !respondedElicits.has(barrier.elicitId),
          )
        );
      }

      const interaction: ChatInteractionRuntime = {
        observe: publishElicit,
        settled(elicitId) {
          respondedElicits.add(elicitId);
          forgetElicit(elicitId);
        },
        cancel(elicitId) {
          respondedElicits.add(elicitId);
          forgetElicit(elicitId);
        },
        localParts: () => new Map(),
        onChange: () => () => undefined,
        setOnCompletion(handler) {
          completionHandler = handler;
        },
        dispose() {
          completionHandler = undefined;
          elicitationBarriers.clear();
          pendingElicits.splice(0);
        },
      };

      const eventMiddleware: ChatEventMiddleware = {
        *accept(args, next) {
          const event = args[0];
          cumulativeEvents.push(event);
          if (!cancellationInProgress) {
            activeTurnEvents?.push(event);
          }
          if (!cancellationInProgress && event.type === EventType.TEXT_MESSAGE_CONTENT) {
            resolveDeltaWaiters(event.delta, event.messageId);
          }
          if (!cancellationInProgress && event.type === EventType.RUN_ERROR) {
            pendingRunError = new Error(event.message);
          }
          if (
            !cancellationInProgress &&
            event.type === EventType.RUN_FINISHED &&
            event.outcome?.type !== "interrupt"
          ) {
            terminalSuccessPending = true;
          }
          yield* next(...args);
        },
      };

      const client: ChatClient = createChatClient({
        threadId: conversationId,
        api: options.baseUrl ?? "/api/chat",
        fetcher: requestOptionsFetch(options.fetch, conversationId, conversationOptions),
        eventMiddleware: [eventMiddleware],
        interaction,
        ...(!conversationOptions.reconnectOnOpen ? { initialConversation: "new" as const } : {}),
        ...(conversationOptions.reconnectOnOpen
          ? {
              initialize: function* (control): Operation<void> {
                yield* call(() => control.reconnect());
              },
            }
          : {}),
      });
      const unsubscribe = client.subscribe(() => {
        const snapshot = client.getServerSnapshot();
        resolveSnapshotWaiters(snapshot);
        if (terminalSuccessPending && snapshot.status === "ready") {
          terminalSuccessPending = false;
          settleTurn();
        }
        if (pendingRunError && snapshot.status === "error") {
          const failure = pendingRunError;
          pendingRunError = undefined;
          failTurn(failure);
        }
      });

      function startTurn(
        message: UserMessageInput,
        supersede: boolean,
        sendMessage = true,
      ): TurnHandle {
        assertOpen();
        if (activeTurn && !supersede) {
          throw new Error(`Complete active turn ${activeTurn.id} before sending another turn`);
        }
        if (activeTurn) {
          failTurn(new Error(`turn_superseded: ${activeTurn.id}`));
        }
        const turnId = crypto.randomUUID();
        const settled = deferred<TurnTranscript>();
        turnSettled = settled;
        activeTurnEvents = [];
        activeTurn = { id: turnId, reject: (error) => settled.reject(error) };
        const launch = async (): Promise<void> => {
          try {
            await client.initialized;
            if (supersede) {
              cancellationInProgress = true;
              try {
                await client.stop();
              } catch (error) {
                if (!(error instanceof Error) || error.message !== "halted") {
                  throw error;
                }
              } finally {
                cancellationInProgress = false;
              }
            }
            if (sendMessage) {
              await client.sendMessage(message);
              const snapshot = client.getServerSnapshot();
              if (
                activeTurn?.id === turnId &&
                snapshot.status === "ready" &&
                snapshot.authority?.state === "idle"
              ) {
                settleTurn();
              }
            }
          } catch (error) {
            if (activeTurn?.id === turnId) {
              failTurn(error);
            }
          }
        };
        void launch();

        return {
          expectTextDelta(expectation) {
            assertOpen();
            const wait = deferred<TextDeltaBarrier>();
            pendingDeltas.push({ expectation, wait });
            return withBarrierTimeout(wait.promise, `text delta for turn ${turnId}`);
          },
          expectElicit(key) {
            assertOpen();
            const pendingIndex = pendingElicits.findIndex((barrier) => barrier.key === key);
            if (pendingIndex !== -1) {
              const [barrier] = pendingElicits.splice(pendingIndex, 1);
              return Promise.resolve(barrier!);
            }
            const published = [...elicitationBarriers.values()].find(
              (barrier) => barrier.key === key && !respondedElicits.has(barrier.elicitId),
            );
            if (published) {
              return Promise.resolve(published);
            }
            const wait = deferred<ElicitBarrier>();
            elicitWaiters.push({ key, wait });
            return withBarrierTimeout(wait.promise, `elicit ${key} for turn ${turnId}`);
          },
          snapshot() {
            assertOpen();
            return client.getServerSnapshot();
          },
          expectSnapshot(predicate) {
            assertOpen();
            const current = client.getServerSnapshot();
            if (predicate(current)) {
              return Promise.resolve(current);
            }
            const wait = deferred<ChatUISnapshot>();
            pendingSnapshots.push({ turnId, predicate, wait });
            return withBarrierTimeout(wait.promise, `snapshot for turn ${turnId}`);
          },
          async cancel() {
            assertOpen();
            cancellationInProgress = true;
            try {
              await client.stop();
            } catch (error) {
              if (!(error instanceof Error) || error.message !== "halted") {
                throw error;
              }
            } finally {
              cancellationInProgress = false;
            }
            failTurn(new Error(`turn_cancelled: ${turnId}`));
          },
          complete() {
            return withBarrierTimeout(settled.promise, `completion for turn ${turnId}`);
          },
        };
      }

      const handle: ConversationHandle = {
        conversationId,
        snapshot: () => client.getServerSnapshot(),
        send: (message) => startTurn(message, false),
        supersede: (message) => startTurn(message, true),
        resumePendingElicit: (key) => {
          assertOpen();
          if (!hasPendingElicit(key)) {
            throw new Error(`No pending elicitation named ${JSON.stringify(key)}`);
          }
          return startTurn(key, false, false);
        },
        async reopen() {
          await owned.close();
          conversations.delete(conversationId);
          const reopened = chatHandle.conversation({
            ...conversationOptions,
            conversationId,
            reconnectOnOpen: true,
          });
          await conversations.get(conversationId)?.ready;
          return reopened;
        },
        transcript: () => ({
          conversationId,
          events: Object.freeze([...cumulativeEvents]),
          text: textFromEvents(cumulativeEvents),
        }),
      };

      const owned: OwnedConversation = {
        handle,
        ready: client.initialized,
        verify() {
          if (activeTurn || turnSettled || pendingDeltas.length || elicitWaiters.length) {
            throw new Error(
              `Conversation ${conversationId} has active work: ` +
                (activeTurn ? "active turn; " : "") +
                `${pendingDeltas.length} delta waiter(s); ` +
                `${elicitWaiters.length} elicit waiter(s)`,
            );
          }
        },
        poison: failTurn,
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          failTurn(
            options.getRootFailure?.() ?? new Error(`Conversation ${conversationId} closed`),
          );
          unsubscribe();
          await client.close();
        },
      };
      conversations.set(conversationId, owned);
      return handle;
    },
  };

  return {
    handle: chatHandle,
    verify() {
      for (const conversation of conversations.values()) {
        conversation.verify();
      }
    },
    poison(error) {
      for (const conversation of conversations.values()) {
        conversation.poison(error);
      }
    },
    async close() {
      await Promise.all([...conversations.values()].map((conversation) => conversation.close()));
      conversations.clear();
    },
  };
}
