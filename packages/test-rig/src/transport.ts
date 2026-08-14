import { EventType } from "@ag-ui/core";
import type { ConversationStreamEvent } from "@sweatpants/chat-client";
import type { ChatFetch } from "./chat.ts";

export interface StreamFrame {
  lsn: number;
  event: ConversationStreamEvent;
}

export interface StreamCheckpoint {
  sessionId: string;
  offset: number;
}

export interface OpenStreamTurnOptions {
  conversationId: string;
  message: string;
}

export interface StreamTurnHandle {
  readonly sessionId: string;
  /** Frames consumed through expectEvent()/complete(), never merely prefetched frames. */
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
  async function open(responsePromise: Promise<Response>): Promise<StreamTurnHandle> {
    const response = await responsePromise;
    if (!response.ok || !response.body) {
      throw new Error(
        `stream transport request failed: ${response.status} ${await response.text()}`,
      );
    }
    const sessionId = response.headers.get("x-session-id");
    if (!sessionId) {
      throw new Error("stream transport response omitted X-Session-Id");
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

    function parseFrame(line: string): StreamFrame {
      const parsed = JSON.parse(line) as StreamFrame;
      if (
        typeof parsed.lsn !== "number" ||
        typeof parsed.event !== "object" ||
        parsed.event === null ||
        typeof parsed.event.type !== "string"
      ) {
        throw new Error(`invalid stream frame: ${line.slice(0, 500)}`);
      }
      return parsed;
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
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
    }

    // Exactly one pump owns reader.read(). Event consumers wait on queues and
    // can time out/retry without creating concurrent Web Stream reads.
    const pump = (async () => {
      try {
        while (true) {
          if (disconnected) {
            break;
          }
          const next = await reader.read();
          if (next.done) {
            break;
          }
          buffer += decoder.decode(next.value, { stream: true });
          while (true) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) {
              break;
            }
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
              deliver(parseFrame(line));
            }
          }
        }
      } catch (error) {
        if (!disconnected) {
          pumpError = error;
        }
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
      if (pumpError) {
        return { promise: Promise.reject(pumpError), cancel() {} };
      }
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
          if (index >= 0) {
            waiters.splice(index, 1);
          }
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
        if (timer) {
          clearTimeout(timer);
        }
      }
    }

    return {
      sessionId,
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
        return { sessionId, offset: consumed.at(-1)?.lsn ?? 0 };
      },
      async disconnect() {
        if (disconnected) {
          return;
        }
        disconnected = true;
        await reader.cancel("test-rig transport disconnect");
        await pump;
      },
      async complete() {
        while (true) {
          const frame = await boundedFrame();
          if (
            frame.event.type === EventType.RUN_FINISHED ||
            frame.event.type === EventType.RUN_ERROR
          ) {
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
        fetch(`/api/chat?conversationId=${encodeURIComponent(options.conversationId)}`, {
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
            input: {
              threadId: options.conversationId,
              runId,
              state: {},
              messages: [
                {
                  id: messageId,
                  role: "user",
                  content: options.message,
                },
              ],
              tools: [],
              context: [],
              forwardedProps: {},
            },
          }),
        }),
      );
    },
    reconnect(checkpoint) {
      return open(
        fetch(`/sessions/${encodeURIComponent(checkpoint.sessionId)}?offset=${checkpoint.offset}`, {
          headers: { Accept: "application/x-ndjson" },
        }),
      );
    },
  };
}
