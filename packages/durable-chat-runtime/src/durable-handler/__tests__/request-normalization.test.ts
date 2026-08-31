import { describe, expect, it } from "vitest";

import { chatRequestBodyParser, parseChatRequestBody } from "../request-normalization.ts";

const issuedAt = Date.now();
const expiresAt = issuedAt + 60_000;

function command(override: Record<string, unknown> = {}, controls: Record<string, unknown> = {}) {
  return {
    command: Object.fromEntries(
      Object.entries({
        type: "send-message",
        commandId: "00000000-0000-4000-8000-000000000001",
        issuedAt,
        expiresAt,
        basisRevision: null,
        messageId: "user:1",
        ...override,
      }).filter(([, value]) => value !== undefined),
    ),
    clientId: "client-1",
    conversationId: "conversation-1",
    userMessage: { id: "user:1", role: "user", content: "hello" },
    runId: "run-1",
    state: { step: 1 },
    context: [],
    forwardedProps: { source: "test" },
    ...controls,
  };
}

describe("parseChatRequestBody", () => {
  it("accepts one matching native send-message without a loaded transcript", () => {
    const parsed = parseChatRequestBody(command());

    expect(parsed.messages).toEqual([
      {
        type: "message",
        id: "user:1",
        message: { role: "user", content: "hello" },
        metadata: {},
      },
    ]);
    expect(parsed.threadId).toBe("conversation-1");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.tools).toEqual([]);
    expect(parsed.state).toEqual({ step: 1 });
  });

  it("returns parser results and rejects oversized native context", () => {
    expect(chatRequestBodyParser.parse(command()).ok).toBe(true);
    expect(
      chatRequestBodyParser.parse(
        command(
          {},
          {
            context: Array.from({ length: 1_025 }, (_, index) => ({
              description: `entry-${index}`,
              value: "bounded",
            })),
          },
        ),
      ).ok,
    ).toBe(false);
  });

  it("uses the AG-UI codec for the single multimodal user message", () => {
    const parsed = parseChatRequestBody(
      command(
        {},
        {
          userMessage: {
            id: "user:1",
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", source: { type: "url", value: "https://example.test/image.png" } },
            ],
          },
        },
      ),
    );
    const entry = parsed.messages[0];
    expect(entry?.type).toBe("message");
    if (!entry || entry.type !== "message" || entry.message.role !== "user") {
      throw new Error("expected user history message entry");
    }
    expect(entry.message.content).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "url", value: "https://example.test/image.png" },
        metadata: null,
      },
    ]);
  });

  it("derives elicitation resume only from respond-to-elicit", () => {
    const parsed = parseChatRequestBody(
      command(
        {
          type: "respond-to-elicit",
          commandId: "00000000-0000-4000-8000-000000000002",
          basisRevision: "2",
          logicalTurnId: "turn-1",
          executionId: "execution-1",
          interruptId: "interrupt:1",
          status: "cancelled",
          messageId: undefined,
        },
        { userMessage: undefined },
      ),
    );

    expect(parsed.messages).toEqual([]);
    expect(parsed.resume).toEqual([{ interruptId: "interrupt:1", status: "cancelled" }]);
    expect(parsed.elicitResponses).toMatchObject([
      {
        sessionId: "execution-1",
        elicitId: "interrupt:1",
        completion: { action: "cancel" },
      },
    ]);
  });

  it.each([
    ["non-object", null],
    ["incomplete reconnect", { clientId: "client" }],
    ["legacy AG-UI input envelope", command({}, { input: { messages: [] } })],
    ["loaded transcript field", command({}, { messages: [] })],
    ["missing matching user message", command({}, { userMessage: undefined })],
    [
      "mismatched user identity",
      command({}, { userMessage: { id: "user:other", role: "user", content: "hello" } }),
    ],
    [
      "non-user send message",
      command({}, { userMessage: { id: "user:1", role: "assistant", content: "hello" } }),
    ],
    ["user message on regenerate", command({ type: "regenerate", messageId: undefined }, {})],
    [
      "binary AG-UI content",
      command(
        {},
        {
          userMessage: {
            id: "user:1",
            role: "user",
            content: [{ type: "binary", mimeType: "application/octet-stream", data: "AA==" }],
          },
        },
      ),
    ],
  ])("rejects %s before turn planning", (_name, value) => {
    expect(() => parseChatRequestBody(value)).toThrow(
      expect.objectContaining({ code: "invalid_chat_request" }),
    );
  });
});
