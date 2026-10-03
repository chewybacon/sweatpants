import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/core";
import { decodeChatContent, decodeAGUIEvent } from "../client.ts";
import type { ChatUIMessage, ChatUIPart } from "../client.ts";
import { emptyFrame } from "@sweatpants/frame-renderer";

describe("Chat Core client facade", () => {
  it("exposes client-safe content and original AG-UI event names", () => {
    expect(decodeChatContent([{ type: "text", text: "hello" }])).toEqual([
      { type: "text", text: "hello" },
    ]);
    expect(
      decodeAGUIEvent({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-1",
        role: "assistant",
      }),
    ).toMatchObject({ type: EventType.TEXT_MESSAGE_START });
  });

  it("keeps the canonical UI type available for client consumers", () => {
    const part: ChatUIPart = {
      type: "text",
      id: "part-1",
      text: "hello",
      state: "done",
      frame: emptyFrame(),
      rendered: "hello",
    };
    const message: ChatUIMessage = {
      id: "message-1",
      role: "assistant",
      parts: [part],
      metadata: {},
    };
    expect(message.parts[0]?.type).toBe("text");
  });
});
