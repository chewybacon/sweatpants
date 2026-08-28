import { EventType } from "@ag-ui/core";
import {
  CONVERSATION_WINDOW_FRAME_TYPE,
  decodeConversationStreamEvent,
  validateConversationSegment,
  type ConversationStreamEvent,
} from "@sweatpants/chat-client";
import type { ChatFetch } from "./chat.ts";

export interface StreamFrame {
  /** Client-local observation sequence; never a public response position. */
  readonly sequence: number;
  readonly event: ConversationStreamEvent;
}

export interface StreamCheckpoint {
  readonly conversationId: string;
  readonly knownWindowToken?: string;
}

export interface OpenStreamTurnOptions {
  conversationId: string;
  message: string;
}

export interface StreamTurnHandle {
  readonly conversationId: string;
  readonly events: readonly StreamFrame[];
  expectEvent(
    type: string,
    assertion?: (event: StreamFrame["event"]) => void,
  ): Promise<StreamFrame>;
  checkpoint(): StreamCheckpoint;
  disconnect(): Promise<void>;
  complete(): Promise<readonly StreamFrame[]>;
}

export interface StreamTransportHandle {
  openTurn(options: OpenStreamTurnOptions): Promise<StreamTurnHandle>;
  reconnect(checkpoint: StreamCheckpoint): Promise<StreamTurnHandle>;
}

interface FrameWaiter {
  resolve(frame: StreamFrame): void;
  reject(error: unknown): void;
}

export function createStreamTransportHandle(
  fetch: ChatFetch,
  barrierTimeoutMs: number,
): StreamTransportHandle {
  async function open(
    conversationId: string,
    responsePromise: Promise<Response>,
  ): Promise<StreamTurnHandle> {
    const response = await responsePromise;
    if (!response.ok || !response.body) {
      throw new Error(
        `stream transport request failed: ${response.status} ${await response.text()}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const queued: StreamFrame[] = [];
    const consumed: StreamFrame[] = [];
    const waiters: FrameWaiter[] = [];
    let buffer = "";
    let ended = false;
    let disconnected = false;
    let pumpError: unknown;
    let sequence = 0;
    let knownWindowToken: string | undefined;

    function parseFrame(line: string): StreamFrame {
      const event = decodeConversationStreamEvent(JSON.parse(line));
      if (event.type === CONVERSATION_WINDOW_FRAME_TYPE) {
        knownWindowToken = event.windowToken;
      }
      return { sequence: ++sequence, event };
    }

    function deliver(frame: StreamFrame): void {
      const waiter = waiters.shift();
      if (waiter) {
        consumed.push(frame);
        waiter.resolve(frame);
      } else {
        queued.push(frame);
      }
    }

    function rejectWaiters(error: unknown): void {
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    }

    const pump = (async () => {
      try {
        while (!disconnected) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          while (true) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) deliver(parseFrame(line));
          }
        }
      } catch (error) {
        if (!disconnected) pumpError = error;
      } finally {
        ended = true;
        rejectWaiters(
          pumpError ?? new Error(disconnected ? "stream transport disconnected" : "stream ended"),
        );
      }
    })();
    void pump.catch(() => undefined);

    function nextFrame(): { promise: Promise<StreamFrame>; cancel(): void } {
      const available = queued.shift();
      if (available) {
        consumed.push(available);
        return { promise: Promise.resolve(available), cancel() {} };
      }
      if (pumpError) return { promise: Promise.reject(pumpError), cancel() {} };
      if (ended) {
        return {
          promise: Promise.reject(new Error("stream transport ended before the expected event")),
          cancel() {},
        };
      }
      let waiter: FrameWaiter;
      const promise = new Promise<StreamFrame>((resolve, reject) => {
        waiter = { resolve, reject };
        waiters.push(waiter);
      });
      return {
        promise,
        cancel() {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
        },
      };
    }

    async function boundedFrame(): Promise<StreamFrame> {
      const pending = nextFrame();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          pending.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              pending.cancel();
              reject(new Error(`barrier_timeout: stream event after ${barrierTimeoutMs}ms`));
            }, barrierTimeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    return {
      conversationId,
      get events() {
        return Object.freeze([...consumed]);
      },
      async expectEvent(type, assertion) {
        while (true) {
          const frame = await boundedFrame();
          if (String(frame.event.type) === type) {
            assertion?.(frame.event);
            return frame;
          }
        }
      },
      checkpoint() {
        return {
          conversationId,
          ...(knownWindowToken === undefined ? {} : { knownWindowToken }),
        };
      },
      async disconnect() {
        if (disconnected) return;
        disconnected = true;
        await reader.cancel("test-rig transport disconnect");
        await pump;
      },
      async complete() {
        while (true) {
          try {
            const frame = await boundedFrame();
            if (
              frame.event.type === EventType.RUN_FINISHED ||
              frame.event.type === EventType.RUN_ERROR
            ) {
              return Object.freeze([...consumed]);
            }
          } catch (error) {
            if (!ended || pumpError || disconnected) throw error;
            validateConversationSegment(consumed.map((frame) => frame.event));
            return Object.freeze([...consumed]);
          }
        }
      },
    };
  }

  return {
    openTurn(options) {
      const runId = crypto.randomUUID();
      const messageId = `user:${crypto.randomUUID()}`;
      return open(
        options.conversationId,
        fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify({
            command: {
              type: "send-message",
              commandId: runId,
              issuedAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              basisRevision: null,
              messageId,
            },
            clientId: "test-rig-stream",
            conversationId: options.conversationId,
            userMessage: { id: messageId, role: "user", content: options.message },
            runId,
            state: {},
            context: [],
            forwardedProps: {},
          }),
        }),
      );
    },
    reconnect(checkpoint) {
      return open(
        checkpoint.conversationId,
        fetch(`/api/chat/${encodeURIComponent(checkpoint.conversationId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify({
            clientId: "test-rig-stream",
            conversationId: checkpoint.conversationId,
            ...(checkpoint.knownWindowToken === undefined
              ? {}
              : { knownWindowToken: checkpoint.knownWindowToken }),
          }),
        }),
      );
    },
  };
}
