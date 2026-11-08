import { createChatClient } from "@sweatpan.ts/chat-client";
import {
  viewSchema,
  answerReceiptSchema,
  type Answer,
  receiptSchema,
  rejectionSchema,
  SubmissionRejected,
  type Submission,
} from "./contracts.ts";
/** Submission is an application command, distinct from answering an elicitation. */
export function createBrowserChat(send: typeof fetch = fetch) {
  let connection: { controller: AbortController; done: Promise<void> } | undefined;
  const client = createChatClient({
    transport: {
      async observe() {
        const response = await send("/api/conversation", { signal: connection?.controller.signal });
        if (!response.ok) {
          throw new Error("Could not load conversation");
        }
        return viewSchema.parse(await response.json());
      },
      async answer(command: Answer) {
        const response = await send("/api/conversation/answers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        });
        if (!response.ok) {
          throw new Error("Answer not confirmed. Retry the same answer.");
        }
        return answerReceiptSchema.parse(await response.json());
      },
    },
  });
  async function follow(signal: AbortSignal) {
    let delay = 250;
    while (!signal.aborted) {
      try {
        const response = await send("/api/conversation/changes", { signal });
        if (!response.ok || !response.body) {
          throw new Error("Could not follow conversation");
        }
        const reader = response.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          if (signal.aborted) {
            break;
          }
          const decoder = new TextDecoder();
          let pending = "";
          while (!signal.aborted) {
            const item = await reader.read();
            if (item.done) {
              throw new Error("Observation disconnected");
            }
            pending += decoder.decode(item.value, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop()!;
            if (pending.length > 4096) {
              throw new Error("Invalid observation frame");
            }
            for (const line of lines) {
              if (JSON.parse(line).type !== "changed") {
                throw new Error("Invalid observation frame");
              }
            }
            if (lines.length && !signal.aborted) {
              // Complete views replace prior ones. Duplicate/overlapping hints
              // cannot append duplicate text, and reconnect needs no old cursor.
              await client.refresh();
              delay = 250;
            }
          }
        } finally {
          signal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      } catch {
        // Retry observation only. Never retry a submission or advance execution.
        if (!signal.aborted) {
          // A finite refresh exposes connection failures through the existing
          // snapshot error state and still works if streaming is unavailable.
          await client.refresh().catch(() => undefined);
        }
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, delay);
          signal.addEventListener("abort", finish, { once: true });
          if (signal.aborted) {
            finish();
          }
        });
        delay = Math.min(delay * 2, 2000);
      }
    }
  }
  return {
    ...client,
    /** Explicit application ownership; React subscribers neither start nor stop it. */
    connect() {
      if (client.getSnapshot().status === "closed") {
        throw new Error("Client closed");
      }
      if (!connection) {
        const controller = new AbortController();
        connection = { controller, done: follow(controller.signal) };
      }
    },
    async disconnect() {
      const current = connection;
      connection = undefined;
      current?.controller.abort();
      await current?.done;
    },
    close() {
      connection?.controller.abort();
      connection = undefined;
      client.close();
    },
    async submit(this: void, command: Submission) {
      if (client.getSnapshot().status === "closed") {
        throw new Error("Client closed");
      }
      const response = await send("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        // HTTP status alone cannot establish whether a previous delivery was accepted.
        const rejected = rejectionSchema.safeParse(await response.json().catch(() => undefined));
        if (
          response.status === 409 &&
          rejected.success &&
          rejected.data.command === command.command
        ) {
          throw new SubmissionRejected(rejected.data.code);
        }
        throw new Error("Submission not confirmed. Refresh or retry the same message.");
      }
      return receiptSchema.parse(await response.json());
    },
  };
}
export type BrowserChat = ReturnType<typeof createBrowserChat>;
