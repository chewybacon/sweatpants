import { call, createScope, each, spawn, type Operation } from "effection";
import {
  createChatSession,
  type ChatCommand,
  type ChatFetch as FrameworkChatFetch,
  type ChatSession,
  type ChatSessionStreamEvent,
  type ChatState,
  type ElicitState,
  type PluginHandleInput,
  type SessionOptions,
} from "@sweatpants/framework/chat";

export type ChatFetch = FrameworkChatFetch;

export interface ConversationOptions {
  conversationId?: string;
  plugins?: PluginHandleInput[];
  tools?: unknown[];
  enabledTools?: string[] | boolean;
  systemPrompt?: string;
  initialToolChoice?: SessionOptions["initialToolChoice"];
  streamOptions?: SessionOptions["streamOptions"];
}

export interface TextDeltaBarrier {
  readonly delta: string;
  readonly messageId?: string;
}

export interface ElicitBarrier {
  readonly key: string;
  readonly elicitId: string;
  readonly context: unknown;
  accept(content?: unknown): Promise<void>;
  decline(): Promise<void>;
  cancel(): Promise<void>;
}

export interface TurnTranscript {
  readonly events: readonly ChatSessionStreamEvent[];
  readonly text: string;
  readonly outcome: "success" | "error" | "interrupt";
}

export interface ConversationTranscript {
  readonly conversationId: string;
  readonly events: readonly ChatSessionStreamEvent[];
  readonly text: string;
}

export interface TurnHandle {
  expectTextDelta(
    expectation: string | RegExp | ((delta: string) => void),
  ): Promise<TextDeltaBarrier>;
  expectElicit(key: string): Promise<ElicitBarrier>;
  cancel(): Promise<void>;
  complete(): Promise<TurnTranscript>;
}

export interface ConversationHandle {
  readonly conversationId: string;
  send(message: string): TurnHandle;
  supersede(message: string): TurnHandle;
  transcript(): ConversationTranscript;
}

export interface ChatHandle {
  conversation(options?: ConversationOptions): ConversationHandle;
}

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
  // Barriers may be rejected during teardown before a caller reaches its await.
  // Attach a passive observer without changing the original promise semantics.
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

function firstPendingElicit(state: ChatState, responded: Set<string>): ElicitState | undefined {
  for (const tracking of Object.values(state.pendingElicits)) {
    for (const elicit of tracking.elicitations) {
      if (elicit.status === "pending" && !responded.has(elicit.elicitId)) {
        return elicit;
      }
    }
  }
  return undefined;
}

function textFromEvents(events: readonly ChatSessionStreamEvent[]): string {
  return events
    .filter(
      (event): event is Extract<ChatSessionStreamEvent, { type: "TEXT_MESSAGE_CONTENT" }> =>
        event.type === "TEXT_MESSAGE_CONTENT",
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

export function createChatRuntime(options: CreateChatRuntimeOptions): ChatRuntime {
  const conversations = new Map<string, OwnedConversation>();

  const chatHandle: ChatHandle = {
    conversation(conversationOptions: ConversationOptions = {}): ConversationHandle {
      const conversationId = conversationOptions.conversationId ?? crypto.randomUUID();
      const existing = conversations.get(conversationId);
      if (existing) {
        return existing.handle;
      }

      const cumulativeEvents: ChatSessionStreamEvent[] = [];
      let activeTurn: { id: string; reject(error: unknown): void } | undefined;
      let closed = false;
      const stateRef: { current: ChatState | null } = { current: null };
      const sessionReady = deferred<ChatSession>();
      let activeTurnEvents: ChatSessionStreamEvent[] | undefined;
      const pendingDeltas: Array<{
        expectation: string | RegExp | ((delta: string) => void);
        wait: Deferred<TextDeltaBarrier>;
      }> = [];
      const pendingElicits: ElicitBarrier[] = [];
      const elicitWaiters: Array<{ key: string; wait: Deferred<ElicitBarrier> }> = [];
      const publishedElicits = new Set<string>();
      const respondedElicits = new Set<string>();
      const elicitationBarriers = new Map<string, ElicitBarrier>();
      let turnSettled: Deferred<TurnTranscript> | undefined;
      let pendingRunError: Error | undefined;
      let serverCancellation: Deferred<void> | undefined;

      // Keep a stable conversation ID on chat POSTs without enabling
      // createChatSession's durable-history GET hydration path.
      const conversationFetch: ChatFetch = async (input, init) => {
        if (
          (init?.method === undefined || init.method === "POST") &&
          typeof init?.body === "string"
        ) {
          try {
            const parsed = JSON.parse(init.body) as Record<string, unknown>;
            parsed["threadId"] = conversationId;
            parsed["conversationId"] = conversationId;
            return options.fetch(input, { ...init, body: JSON.stringify(parsed) });
          } catch {
            // Not JSON — pass through unchanged.
          }
        }
        return options.fetch(input, init);
      };

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
        activeTurn?.reject(error);
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
            waiter.wait.resolve({
              delta,
              ...(messageId ? { messageId } : {}),
            });
          } catch (error) {
            pendingDeltas.splice(index, 1);
            waiter.wait.reject(error);
          }
        }
      }

      function publishElicits(state: ChatState): void {
        while (true) {
          const pending = firstPendingElicit(state, publishedElicits);
          if (!pending || !activeTurn) {
            return;
          }
          publishedElicits.add(pending.elicitId);
          const barrier = createElicitBarrier(pending);
          elicitationBarriers.set(pending.elicitId, barrier);
          const matchingWaiters = elicitWaiters.filter((waiter) => waiter.key === pending.key);
          if (matchingWaiters.length === 0) {
            pendingElicits.push(barrier);
            continue;
          }
          for (const waiter of matchingWaiters) {
            elicitWaiters.splice(elicitWaiters.indexOf(waiter), 1);
            waiter.wait.resolve(barrier);
          }
        }
      }

      function createElicitBarrier(elicit: ElicitState): ElicitBarrier {
        let answered = false;
        const answer = async (
          result:
            | { action: "accept"; content?: unknown }
            | { action: "decline" }
            | { action: "cancel" },
        ): Promise<void> => {
          assertOpen();
          if (answered || respondedElicits.has(elicit.elicitId)) {
            throw new Error(`Elicit ${elicit.key} was already answered`);
          }
          answered = true;
          respondedElicits.add(elicit.elicitId);
          const session = await sessionReady.promise;
          const command: ChatCommand = {
            type: "elicit_response",
            sessionId: elicit.sessionId,
            callId: elicit.callId,
            ...(elicit.toolName ? { toolName: elicit.toolName } : {}),
            elicitId: elicit.elicitId,
            result,
            autoContinue: true,
          };
          session.dispatch(command);
        };

        return {
          key: elicit.key,
          elicitId: elicit.elicitId,
          context: elicit.context,
          accept: (content) => answer({ action: "accept", content }),
          decline: () => answer({ action: "decline" }),
          cancel: () => answer({ action: "cancel" }),
        };
      }

      function settleTurn(): void {
        if (!turnSettled || !activeTurnEvents) {
          return;
        }
        const events = activeTurnEvents;
        const transcript: TurnTranscript = {
          events: Object.freeze([...events]),
          text: textFromEvents(events),
          outcome: "success",
        };
        for (const waiter of pendingDeltas.splice(0)) {
          waiter.wait.reject(new Error("Turn completed before the expected text delta"));
        }
        for (const waiter of elicitWaiters.splice(0)) {
          waiter.wait.reject(new Error("Turn completed before the expected elicit barrier"));
        }
        turnSettled.resolve(transcript);
        activeTurn = undefined;
        activeTurnEvents = undefined;
        turnSettled = undefined;
      }

      // Own one Effection scope for the conversation lifetime. Dispatch and
      // state observation both happen inside this scope, matching the working
      // createChatSession acceptance pattern.
      const [conversationScope, destroyConversationScope] = createScope();
      const conversationTask = conversationScope.run(function* (): Operation<void> {
        try {
          const session = yield* createChatSession({
            baseUrl: options.baseUrl ?? "/api/chat",
            fetch: conversationFetch,
            ...(conversationOptions.plugins ? { plugins: conversationOptions.plugins } : {}),
            ...(conversationOptions.tools ? { tools: conversationOptions.tools } : {}),
            ...(conversationOptions.enabledTools !== undefined
              ? { enabledTools: conversationOptions.enabledTools }
              : {}),
            ...(conversationOptions.systemPrompt
              ? { systemPrompt: conversationOptions.systemPrompt }
              : {}),
            ...(conversationOptions.initialToolChoice
              ? { initialToolChoice: conversationOptions.initialToolChoice }
              : {}),
            ...(conversationOptions.streamOptions
              ? { streamOptions: conversationOptions.streamOptions }
              : {}),
            onStreamEvent: ({ event }) => {
              cumulativeEvents.push(event);
              activeTurnEvents?.push(event);
              if (event.type === "TEXT_MESSAGE_CONTENT") {
                resolveDeltaWaiters(event.delta, event.messageId);
              }
              if (event.type === "RUN_ERROR") {
                pendingRunError = new Error(event.message);
              }
            },
            onTurnSettled: (result) => {
              if (pendingRunError) {
                const error = pendingRunError;
                pendingRunError = undefined;
                failTurn(error);
              } else if (result.type === "complete") {
                settleTurn();
              } else if (stateRef.current) {
                // Publish elicit barriers only after createChatSession has
                // persisted the interrupted request into client history.
                publishElicits(stateRef.current);
              }
            },
            onRequestError: (error) => {
              pendingRunError ??=
                error instanceof Error ? error : new Error(String(error ?? "request failed"));
            },
            onRequestFinished: () => {
              serverCancellation?.resolve();
              if (pendingRunError && activeTurn) {
                const error = pendingRunError;
                pendingRunError = undefined;
                failTurn(error);
              }
            },
          });

          const firstState = deferred<void>();
          yield* spawn(function* () {
            for (const next of yield* each(session.state)) {
              stateRef.current = next;
              firstState.resolve();
              yield* each.next();
            }
          });

          yield* call(() => firstState.promise);
          sessionReady.resolve(session);

          // Keep the resource scope alive for the conversation lifetime.
          yield* call(() => new Promise<never>(() => {}));
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error ?? "chat session failed"));
          options.onPoison?.(failure);
          sessionReady.reject(failure);
          failTurn(failure);
        }
      });

      function retireOpenElicits(): void {
        for (const barrier of elicitationBarriers.values()) {
          respondedElicits.add(barrier.elicitId);
        }
        pendingElicits.splice(0);
      }

      function startTurn(message: string, supersede: boolean): TurnHandle {
        assertOpen();
        if (activeTurn) {
          if (!supersede) {
            throw new Error(`Complete active turn ${activeTurn.id} before sending another turn`);
          }
          retireOpenElicits();
          failTurn(new Error(`turn_superseded: ${activeTurn.id}`));
        }
        const turnId = crypto.randomUUID();
        const settled = deferred<TurnTranscript>();
        turnSettled = settled;
        activeTurnEvents = [];
        pendingRunError = undefined;
        activeTurn = {
          id: turnId,
          reject: (error) => settled.reject(error),
        };

        void sessionReady.promise
          .then((session) => {
            session.dispatch({ type: "send", content: message });
            return undefined;
          })
          .catch((error) => {
            failTurn(error);
          });

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
          async cancel() {
            assertOpen();
            const session = await sessionReady.promise;
            const cancelled = deferred<void>();
            serverCancellation = cancelled;
            session.dispatch({ type: "abort" });
            failTurn(new Error(`turn_cancelled: ${turnId}`));
            await withBarrierTimeout(cancelled.promise, `server cancellation for turn ${turnId}`);
            if (serverCancellation === cancelled) {
              serverCancellation = undefined;
            }
          },
          complete() {
            return withBarrierTimeout(settled.promise, `completion for turn ${turnId}`);
          },
        };
      }

      const handle: ConversationHandle = {
        conversationId,
        send(message: string): TurnHandle {
          return startTurn(message, false);
        },
        supersede(message: string): TurnHandle {
          return startTurn(message, true);
        },
        transcript() {
          return {
            conversationId,
            events: Object.freeze([...cumulativeEvents]),
            text: textFromEvents(cumulativeEvents),
          };
        },
      };

      const owned: OwnedConversation = {
        handle,
        verify() {
          if (activeTurn || turnSettled || pendingDeltas.length || elicitWaiters.length) {
            throw new Error(
              `Conversation ${conversationId} has active work: ` +
                `${activeTurn ? "active turn; " : ""}` +
                `${pendingDeltas.length} delta waiter(s); ` +
                `${elicitWaiters.length} elicit waiter(s)`,
            );
          }
        },
        poison(error) {
          failTurn(error);
        },
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          const error =
            options.getRootFailure?.() ?? new Error(`Conversation ${conversationId} closed`);
          failTurn(error);
          sessionReady.reject(error);
          try {
            await destroyConversationScope();
          } catch (haltError) {
            const expectedTermination =
              haltError instanceof Error &&
              (haltError.message === "halted" ||
                haltError.name === "AbortError" ||
                /operation was aborted/i.test(haltError.message));
            if (!expectedTermination) {
              throw haltError;
            }
          }
          await conversationTask.catch(() => undefined);
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
