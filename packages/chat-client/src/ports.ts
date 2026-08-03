import { createContext, type Around, type Operation, type Stream } from "effection";
import { createApi } from "effection/experimental";
import { definePort } from "@sweatpants/foundation/port";
import type {
  ChatSendRequest,
  ChatReconnectRequest,
  ChatStreamEvent,
  ChatTransportContract,
  UserMessageInput,
  SendMessageOptions,
  RegenerateOptions,
} from "@sweatpants/chat-core";
import { ChatClientError } from "./errors.ts";

export const ChatTransportPort = definePort<ChatTransportContract>("sweatpants:chat-transport", {
  *sendMessages(_request: ChatSendRequest, _signal: AbortSignal) {
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
  cancelQueued(id: string): Operation<void>;
  setMessages(update: unknown): Operation<void>;
  clearError(): Operation<void>;
  close(): Operation<void>;
}

const ChatCommandContext = createContext<ChatCommandImplementation>(
  "sweatpants:chat-command-implementation",
);

export interface ChatEventContract {
  accept(event: ChatStreamEvent): Operation<void>;
}

const ChatEventContext = createContext<ChatEventContract>("sweatpants:chat-event-implementation");

/**
 * Validated events are immutable facts. Middleware may observe, delay, reject,
 * or inject faults around acceptance, but it cannot replace the event.
 */
export const ChatEventApi = createApi<ChatEventContract>("sweatpants:chat-event-api", {
  *accept(event: ChatStreamEvent) {
    return yield* (yield* ChatEventContext.expect()).accept(event);
  },
});

/**
 * Semantic command middleware is a separate API from transport. The core
 * delegates through an internal scope Context, while callers only receive the
 * public facade and cannot obtain a transport driver.
 */
export const ChatClientApi = createApi<ChatClientCommandContract>("sweatpants:chat-client-api", {
  *sendMessage(input: UserMessageInput, options?: SendMessageOptions) {
    return yield* (yield* ChatCommandContext.expect()).sendMessage(input, options);
  },
  *stop() {
    return yield* (yield* ChatCommandContext.expect()).stop();
  },
  *regenerate(options?: RegenerateOptions) {
    return yield* (yield* ChatCommandContext.expect()).regenerate(options);
  },
  *reconnect() {
    return yield* (yield* ChatCommandContext.expect()).reconnect();
  },
  *cancelQueued(id: string) {
    return yield* (yield* ChatCommandContext.expect()).cancelQueued(id);
  },
  *setMessages(update: unknown) {
    return yield* (yield* ChatCommandContext.expect()).setMessages(update);
  },
  *clearError() {
    return yield* (yield* ChatCommandContext.expect()).clearError();
  },
  *close() {
    return yield* (yield* ChatCommandContext.expect()).close();
  },
});

export { ChatCommandContext, ChatEventContext };

export type ChatTransportMiddleware = Partial<Around<ChatTransportContract>>;
export type ChatClientMiddleware = Partial<Around<ChatClientCommandContract>>;
export type ChatEventMiddleware = Partial<Around<ChatEventContract>>;
