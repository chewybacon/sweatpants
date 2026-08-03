import { EventType } from "@ag-ui/core";
import type { Operation, Stream } from "effection";
import { describe, expect, it } from "vitest";
import {
  ChatTransportPort,
  createChatClient,
  type ChatStreamEvent,
  type ChatTransportContract,
} from "./index.ts";

function streamOf(events: readonly ChatStreamEvent[]): Stream<ChatStreamEvent, void> {
  return (function* () {
    let index = 0;
    return {
      next(): Operation<IteratorResult<ChatStreamEvent, void>> {
        return (function* () {
          if (index >= events.length) {
            return { done: true, value: undefined };
          }
          return { done: false, value: events[index++] };
        })();
      },
    };
  })();
}

function transport(events: readonly ChatStreamEvent[]): ChatTransportContract {
  return {
    *sendMessages() {
      return streamOf(events);
    },
    *reconnectToStream() {
      return null;
    },
    *disconnect() {
      return;
    },
  };
}

describe("headless ChatClient", () => {
  it("completes a turn with the active assistant in messages", async () => {
    const client = createChatClient({
      conversationId: "conversation-1",
      transport: {
        driver: transport([
          { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-1" },
          { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-1", role: "assistant" },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "assistant-1",
            delta: "Hello **world**",
          },
          { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
          { type: EventType.RUN_FINISHED, threadId: "conversation-1", runId: "run-1" },
        ]),
      },
    });
    await client.initialized;
    await client.sendMessage({ text: "Hi" });
    const snapshot = client.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(snapshot.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "Hello **world**",
      state: "done",
    });
    expect(
      snapshot.messages[1]?.parts[0]?.type === "text" && snapshot.messages[1]?.parts[0]?.rendered,
    ).toContain("<strong>world</strong>");
    const authoritative = client.getServerSnapshot();
    client.setMessages([]);
    expect(client.getSnapshot().messages).toHaveLength(0);
    expect(client.getServerSnapshot().messages).toEqual(authoritative.messages);
    await client.close();
  });

  it("keeps subscription observation separate from transport", async () => {
    let calls = 0;
    const client = createChatClient({
      conversationId: "conversation-3",
      transport: {
        driver: {
          *sendMessages() {
            calls += 1;
            return streamOf([
              { type: EventType.RUN_STARTED, threadId: "c", runId: "r" },
              { type: EventType.RUN_FINISHED, threadId: "c", runId: "r" },
            ]);
          },
          *reconnectToStream() {
            return null;
          },
          *disconnect() {
            return;
          },
        },
      },
    });
    const unsubscribe = client.subscribe(() => undefined);
    await client.initialized;
    expect(calls).toBe(0);
    unsubscribe();
    await client.close();
  });

  it("seals required drivers before initialize", async () => {
    const client = createChatClient({
      conversationId: "sealed",
      initialize: function* () {
        yield* ChatTransportPort.installDriver(transport([]));
      },
    });
    await expect(client.initialized).rejects.toMatchObject({
      code: "chat_client_configuration_sealed",
    });
    await client.close();
  });
});
