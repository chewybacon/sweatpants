import type { ChatFetch } from "./chat.ts";

export interface StreamFrame {
  lsn: number;
  event: { type: string; [key: string]: unknown };
}

export interface StreamCheckpoint {
  sessionId: string;
  offset: number;
}

export interface OpenStreamTurnOptions {
  conversationId: string;
  message: string;
  enabledTools?: boolean | string[];
}

export interface StreamTurnHandle {
  readonly sessionId: string;
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
    const events: StreamFrame[] = [];
    const queued: StreamFrame[] = [];
    let buffer = "";
    let terminal = false;
    let disconnected = false;

    async function readFrame(): Promise<StreamFrame> {
      while (queued.length === 0) {
        const next = await reader.read();
        if (next.done) {
          throw new Error("stream transport ended before the expected event");
        }
        buffer += decoder.decode(next.value, { stream: true });
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) {
            break;
          }
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) {
            continue;
          }
          const parsed = JSON.parse(line) as StreamFrame;
          if (
            typeof parsed.lsn !== "number" ||
            typeof parsed.event !== "object" ||
            parsed.event === null ||
            typeof parsed.event.type !== "string"
          ) {
            throw new Error(`invalid stream frame: ${line.slice(0, 500)}`);
          }
          events.push(parsed);
          queued.push(parsed);
        }
      }
      return queued.shift()!;
    }

    async function boundedFrame(): Promise<StreamFrame> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          readFrame(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`barrier_timeout: stream event after ${barrierTimeoutMs}ms`)),
              barrierTimeoutMs,
            );
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
        return Object.freeze([...events]);
      },
      async expectEvent(type, assertion) {
        while (true) {
          const frame = await boundedFrame();
          if (frame.event.type !== type) {
            continue;
          }
          assertion?.(frame.event);
          return frame;
        }
      },
      checkpoint() {
        return { sessionId, offset: events.at(-1)?.lsn ?? 0 };
      },
      async disconnect() {
        if (disconnected) {
          return;
        }
        disconnected = true;
        await reader.cancel("test-rig transport disconnect");
      },
      async complete() {
        while (!terminal) {
          const frame = await boundedFrame();
          if (frame.event.type === "RUN_FINISHED" || frame.event.type === "RUN_ERROR") {
            terminal = true;
          }
        }
        return Object.freeze([...events]);
      },
    };
  }

  return {
    openTurn(options) {
      return open(
        fetch(`/api/chat?conversationId=${encodeURIComponent(options.conversationId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify({
            threadId: options.conversationId,
            conversationId: options.conversationId,
            messages: [
              {
                id: `user:${crypto.randomUUID()}`,
                role: "user",
                content: options.message,
              },
            ],
            ...(options.enabledTools !== undefined ? { enabledTools: options.enabledTools } : {}),
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
