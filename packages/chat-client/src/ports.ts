import type { OperationMiddleware } from "@sweatpants/foundation";
import { createContext, type Operation, type Stream } from "effection";
import { createApi } from "effection/experimental";
import { definePort } from "@sweatpants/foundation/port";
import type {
  ChatTransportRequest,
  ChatReconnectRequest,
  AGUIEvent,
  ChatTransportContract,
  UserMessageInput,
  SendMessageOptions,
  RegenerateOptions,
} from "@sweatpants/chat-core";
import { ChatClientError } from "./errors.ts";

export const ChatTransportPort = definePort<ChatTransportContract>("sweatpants:chat-transport", {
  *sendMessages(_request: ChatTransportRequest, _signal: AbortSignal) {
    throw new ChatClientError(
      "chat_transport_unavailable",
      "No chat transport driver is installed",
    );
  },
  *reconnectToStream(_request: ChatReconnectRequest, _signal: AbortSignal) {
    throw new ChatClientError(
      "chat_transport_unavailable",
      "No chat transport driver is installed",
    );
  },
  *loadHistoryPage(_conversationId: string, _cursor: string, _signal: AbortSignal) {
    throw new ChatClientError(
      "chat_transport_unavailable",
      "The chat transport does not support history paging",
    );
  },
  *disconnect(_reason?: string) {
    throw new ChatClientError(
      "chat_transport_unavailable",
      "No chat transport driver is installed",
    );
  },
});

export interface ChatSchedulerContract {
  /** A frontend-owned stream of presentation opportunities. */
  clock(): Stream<unknown, never>;
}

export const ChatSchedulerPort = definePort<ChatSchedulerContract>("sweatpants:chat-scheduler", {
  clock() {
    return (function* (): Stream<unknown, never> {
      throw new ChatClientError(
        "chat_scheduler_unavailable",
        "No chat scheduler driver is installed",
      );
    })();
  },
});

export interface ChatClientCommandContract {
  sendMessage(input: UserMessageInput, options?: SendMessageOptions): Operation<void>;
  stop(): Operation<void>;
  regenerate(options?: RegenerateOptions): Operation<void>;
  reconnect(): Operation<void>;
  loadOlder(): Operation<void>;
  cancelQueued(id: string): Operation<void>;
  setMessages(update: unknown): Operation<void>;
  clearError(): Operation<void>;
  close(): Operation<void>;
}

interface ChatCommandImplementation {
  sendMessage(input: UserMessageInput, options?: SendMessageOptions): Operation<void>;
  stop(): Operation<void>;
  regenerate(options?: RegenerateOptions): Operation<void>;
  reconnect(): Operation<void>;
  loadOlder(): Operation<void>;
  cancelQueued(id: string): Operation<void>;
  setMessages(update: unknown): Operation<void>;
  clearError(): Operation<void>;
  close(): Operation<void>;
}

const ChatCommandContext = createContext<ChatCommandImplementation>(
  "sweatpants:chat-command-implementation",
);

export interface ChatEventContract {
  accept(event: AGUIEvent): Operation<void>;
}

const ChatEventContext = createContext<ChatEventContract>("sweatpants:chat-event-implementation");

/**
 * Validated events are immutable facts. Middleware may observe, delay, reject,
 * or inject faults around acceptance, but it cannot replace the event.
 */
export const ChatEventApi = createApi<ChatEventContract>("sweatpants:chat-event-api", {
  *accept(event: AGUIEvent) {
    const events = yield* ChatEventContext.expect();
    return yield* events.accept(event);
  },
});

/**
 * Semantic command middleware is a separate API from transport. The core
 * delegates through an internal scope Context, while callers only receive the
 * public facade and cannot obtain a transport driver.
 */
export const ChatClientApi = createApi<ChatClientCommandContract>("sweatpants:chat-client-api", {
  *sendMessage(input: UserMessageInput, options?: SendMessageOptions) {
    const commands = yield* ChatCommandContext.expect();
    return yield* commands.sendMessage(input, options);
  },
  *stop() {
    const commands = yield* ChatCommandContext.expect();
    return yield* commands.stop();
  },
  *regenerate(options?: RegenerateOptions) {
    const commands = yield* ChatCommandContext.expect();
    return yield* commands.regenerate(options);
  },
  *reconnect() {
    const commands = yield* ChatCommandContext.expect();
    return yield* commands.reconnect();
  },
  *loadOlder() {
    const commands = yield* ChatCommandContext.expect();
    return yield* commands.loadOlder();
  },
  *cancelQueued(id: string) {
    const commands = yield* ChatCommandContext.expect();
    return yield* commands.cancelQueued(id);
  },
  *setMessages(update: unknown) {
    const commands = yield* ChatCommandContext.expect();
    return yield* commands.setMessages(update);
  },
  *clearError() {
    const commands = yield* ChatCommandContext.expect();
    return yield* commands.clearError();
  },
  *close() {
    const commands = yield* ChatCommandContext.expect();
    return yield* commands.close();
  },
});

export { ChatCommandContext, ChatEventContext };

export type ChatTransportMiddleware = OperationMiddleware<ChatTransportContract>;
export type ChatClientMiddleware = OperationMiddleware<ChatClientCommandContract>;
export type ChatEventMiddleware = OperationMiddleware<ChatEventContract>;
