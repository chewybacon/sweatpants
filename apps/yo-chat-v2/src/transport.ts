import { createChatClient } from "@sweatpan.ts/chat-client";
import {
  viewSchema,
  receiptSchema,
  rejectionSchema,
  SubmissionRejected,
  type Submission,
} from "./contracts.ts";
/** Submission is an application command, distinct from answering an elicitation. */
export function createBrowserChat(send: typeof fetch = fetch) {
  const client = createChatClient({
    transport: {
      async observe() {
        const response = await send("/api/conversation");
        if (!response.ok) {
          throw new Error("Could not load conversation");
        }
        return viewSchema.parse(await response.json());
      },
      async answer(_command: never): Promise<never> {
        throw new Error("This app has no tool questions yet");
      },
    },
  });
  return {
    ...client,
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
