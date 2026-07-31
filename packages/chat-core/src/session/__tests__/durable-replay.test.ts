import { describe, expect, it } from "vitest";
import { each, run, type Operation } from "effection";
import type { ChatEventTransform } from "../options.ts";
import { deduplicateMessages, replayFramesToConversation } from "../durable-history.ts";
import { chatReducer, initialChatState } from "../../state/reducer.ts";
import type { Message } from "@sweatpants/chat-core";

const renderTransform: ChatEventTransform = function* (input, output): Operation<void> {
  for (const event of yield* each(input)) {
    if (event.type === "TEXT_MESSAGE_END") {
      yield* output.send({
        type: "LOCAL_RENDER_END",
        partType: "text",
        partId: `${event.messageId}:text`,
        frame: {
          id: "frame",
          timestamp: Date.now(),
          trace: [],
          activeBlockIndex: null,
          blocks: [
            {
              id: "block",
              type: "text",
              raw: "**hello**",
              rendered: "<strong>hello</strong>",
              status: "complete",
              renderPass: "full",
            },
          ],
        },
      });
    }
    yield* output.send(event);
    yield* each.next();
  }
};

describe("durable AG-UI replay", () => {
  it("hydrates completed messages through rendering transforms", async () => {
    const replay = await run(function* () {
      return yield* replayFramesToConversation(
        [
          {
            lsn: 1,
            event: {
              type: "MESSAGES_SNAPSHOT",
              messages: [{ id: "assistant-1", role: "assistant", content: "**hello**" }],
            },
          },
        ],
        [],
        [renderTransform],
      );
    });
    const state = replay.events.reduce(chatReducer, initialChatState);
    expect(state.finalizedParts["assistant-1"]?.[0]).toMatchObject({
      content: "**hello**",
      rendered: "<strong>hello</strong>",
    });
  });

  it("keeps replay-enriched duplicate tool messages", () => {
    const messages: Message[] = [
      {
        id: "plain",
        role: "tool",
        tool_call_id: "call",
        name: "search",
        content: "plain",
        isError: false,
      },
      {
        id: "replay",
        role: "tool",
        tool_call_id: "call",
        name: "search",
        content: "rich",
        isError: false,
        replay: { trace: [] },
      },
    ];
    expect(deduplicateMessages(messages)).toEqual([messages[1]]);
  });

  it("keeps the first duplicate when it is already replay-enriched", () => {
    const messages: Message[] = [
      {
        id: "rich",
        role: "tool",
        tool_call_id: "call",
        name: "search",
        content: "rich",
        isError: false,
        replay: { trace: [] },
      },
      {
        id: "plain",
        role: "tool",
        tool_call_id: "call",
        name: "search",
        content: "plain",
        isError: false,
      },
    ];
    expect(deduplicateMessages(messages)).toEqual([messages[0]]);
  });

  it("deduplicates assistant tool hosts by tool-call-id set", () => {
    const toolCalls: Message["tool_calls"] = [
      { id: "call-2", type: "function", function: { name: "two", arguments: {} } },
      { id: "call-1", type: "function", function: { name: "one", arguments: {} } },
    ];
    const messages: Message[] = [
      { id: "host-a", role: "assistant", content: "", tool_calls: toolCalls },
      { id: "host-b", role: "assistant", content: "", tool_calls: [...toolCalls].reverse() },
    ];
    expect(deduplicateMessages(messages)).toEqual([messages[0]]);
  });

  it("keeps distinct assistant tool iterations", () => {
    const messages: Message[] = [
      {
        id: "host-a",
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "one", arguments: {} } }],
      },
      {
        id: "host-b",
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-2", type: "function", function: { name: "two", arguments: {} } }],
      },
    ];
    expect(deduplicateMessages(messages)).toEqual(messages);
  });
});
