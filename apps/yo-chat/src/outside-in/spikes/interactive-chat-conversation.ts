import type { ElicitState } from "@sweatpants/framework/chat";
import type { ChatBinding } from "../lib/chat-fetch.ts";
import {
  runChatFlow,
  type ChatTurn,
  type ElicitReply,
  type RunChatFlowOptions,
} from "../lib/driver.ts";
import type { Transcript } from "../lib/transcript.ts";

export interface ElicitBarrier {
  elicit: ElicitState;
  accept(content?: unknown): Promise<void>;
  decline(): Promise<void>;
  cancel(): Promise<void>;
}

export interface InteractiveChatTurn {
  /** Wait until this turn parks on a named public elicitation. */
  nextElicit(key: string): Promise<ElicitBarrier>;
  /** Wait until this turn reaches a terminal or interrupt-free quiet boundary. */
  complete(): Promise<Transcript>;
}

export interface InteractiveChatConversation {
  readonly conversationId: string;
  send(message: string): InteractiveChatTurn;
  close(): Promise<Transcript>;
}

export type StartInteractiveConversationOptions = Omit<RunChatFlowOptions, "turns">;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTurnQueue(): AsyncIterable<ChatTurn> & {
  push(turn: ChatTurn): void;
  close(): void;
} {
  const pending: ChatTurn[] = [];
  const readers: Deferred<IteratorResult<ChatTurn>>[] = [];
  let closed = false;

  return {
    push(turn) {
      if (closed) {
        throw new Error("Interactive conversation is closed");
      }
      const reader = readers.shift();
      if (reader) {
        reader.resolve({ done: false, value: turn });
      } else {
        pending.push(turn);
      }
    },
    close() {
      closed = true;
      for (const reader of readers.splice(0)) {
        reader.resolve({ done: true, value: undefined });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          const turn = pending.shift();
          if (turn) {
            return Promise.resolve({ done: false as const, value: turn });
          }
          if (closed) {
            return Promise.resolve({ done: true as const, value: undefined });
          }
          const reader = deferred<IteratorResult<ChatTurn>>();
          readers.push(reader);
          return reader.promise;
        },
      };
    },
  };
}

/**
 * Conversation-oriented tracer harness. One real createChatSession remains
 * alive while tests submit turns one at a time and control semantic barriers.
 */
export function startInteractiveConversation(
  binding: ChatBinding,
  options: StartInteractiveConversationOptions = {},
): InteractiveChatConversation {
  const conversationId = options.conversationId ?? crypto.randomUUID();
  const turns = createTurnQueue();
  let active = false;
  let closed = false;
  let rejectActive: ((error: unknown) => void) | undefined;

  const flow = runChatFlow(binding, {
    ...options,
    conversationId,
    turns,
  });
  void flow.catch((error: unknown) => {
    rejectActive?.(error);
  });

  return {
    conversationId,
    send(message) {
      if (closed) {
        throw new Error("Interactive conversation is closed");
      }
      if (active) {
        throw new Error("Complete the active turn before sending another turn");
      }
      active = true;

      const settled = deferred<Transcript>();
      const pendingElicits: ElicitBarrier[] = [];
      const elicitWaiters: Array<{ key: string; deferred: Deferred<ElicitBarrier> }> = [];
      rejectActive = (error) => {
        settled.reject(error);
        for (const waiter of elicitWaiters.splice(0)) {
          waiter.deferred.reject(error);
        }
      };

      function publish(barrier: ElicitBarrier): void {
        const waiterIndex = elicitWaiters.findIndex(({ key }) => key === barrier.elicit.key);
        if (waiterIndex === -1) {
          pendingElicits.push(barrier);
          return;
        }
        const [waiter] = elicitWaiters.splice(waiterIndex, 1);
        waiter!.deferred.resolve(barrier);
      }

      turns.push({
        message,
        respondToElicit(elicit) {
          const reply = deferred<ElicitReply>();
          let answered = false;

          function answer(value: ElicitReply): Promise<void> {
            if (answered) {
              return Promise.reject(new Error(`Elicit ${elicit.key} was already answered`));
            }
            answered = true;
            reply.resolve(value);
            return Promise.resolve();
          }

          publish({
            elicit,
            accept: (content) => answer({ action: "accept", content }),
            decline: () => answer({ action: "decline" }),
            cancel: () => answer({ action: "cancel" }),
          });
          return reply.promise;
        },
        onSettled(transcript) {
          active = false;
          rejectActive = undefined;
          const error = new Error("Turn completed before the expected elicit barrier");
          for (const waiter of elicitWaiters.splice(0)) {
            waiter.deferred.reject(error);
          }
          settled.resolve(transcript);
        },
      });

      return {
        nextElicit(key) {
          const pendingIndex = pendingElicits.findIndex((barrier) => barrier.elicit.key === key);
          if (pendingIndex !== -1) {
            const [barrier] = pendingElicits.splice(pendingIndex, 1);
            return Promise.resolve(barrier!);
          }
          const waiter = deferred<ElicitBarrier>();
          elicitWaiters.push({ key, deferred: waiter });
          return waiter.promise;
        },
        complete() {
          return settled.promise;
        },
      };
    },
    async close() {
      if (active) {
        throw new Error("Cannot close an interactive conversation with an active turn");
      }
      if (!closed) {
        closed = true;
        turns.close();
      }
      return flow;
    },
  };
}
