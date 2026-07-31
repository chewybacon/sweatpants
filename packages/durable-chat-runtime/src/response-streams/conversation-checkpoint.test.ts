import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../handler/types.ts";
import {
  ConversationCheckpointError,
  decodeConversationCheckpoint,
  encodeConversationCheckpoint,
} from "./conversation-checkpoint.ts";

const events: StreamEvent[] = [
  {
    type: "RUN_STARTED",
    threadId: "thread-1",
    runId: "run-1",
    input: {
      threadId: "thread-1",
      runId: "run-1",
      state: { resumed: false },
      messages: [
        { id: "user-1", role: "user", content: "Book a flight" },
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "bookFlight", arguments: "{}" },
            },
          ],
        },
      ],
      tools: [{ name: "bookFlight", description: "Books a flight", parameters: {} }],
      context: [{ description: "locale", value: "en-US" }],
      forwardedProps: {},
      resume: [{ interruptId: "interrupt-1", status: "resolved", payload: { ok: true } }],
    },
  },
  {
    type: "MESSAGES_SNAPSHOT",
    messages: [
      { id: "tool-1", role: "tool", content: "done", toolCallId: "call-1", name: "bookFlight" },
    ],
  },
  {
    type: "STATE_SNAPSHOT",
    snapshot: {
      replay: {
        toolTraces: [
          {
            callId: "call-1",
            toolName: "bookFlight",
            trace: {
              version: 1,
              startedAt: 1,
              completedAt: 2,
              emissions: [
                {
                  order: 0,
                  emissionId: "emission-1",
                  componentKey: "FlightCard",
                  props: { flight: "FL001" },
                  timestamp: 2,
                },
              ],
            },
          },
        ],
      },
      pendingClientActions: [
        {
          toolCallId: "call-1",
          toolName: "bookFlight",
          kind: "elicit",
          sessionId: "call-1",
          elicitId: "interrupt-1",
          key: "pickFlight",
          message: "Pick a flight",
          schema: { type: "object" },
        },
      ],
    },
  },
  { type: "TEXT_MESSAGE_START", messageId: "assistant-2", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-2", delta: "Booked." },
  { type: "TEXT_MESSAGE_END", messageId: "assistant-2" },
  { type: "TOOL_CALL_START", toolCallId: "call-2", toolCallName: "notify" },
  { type: "TOOL_CALL_ARGS", toolCallId: "call-2", delta: "{}" },
  { type: "TOOL_CALL_END", toolCallId: "call-2" },
  {
    type: "TOOL_CALL_RESULT",
    messageId: "tool-2",
    toolCallId: "call-2",
    toolCallName: "notify",
    content: "ok",
    role: "tool",
    isError: false,
  },
  {
    type: "ACTIVITY_SNAPSHOT",
    messageId: "sweatpants:plugin-replay:call-1",
    activityType: "sweatpants:plugin-replay",
    replace: true,
    content: {
      version: 1,
      toolCallId: "call-1",
      toolName: "bookFlight",
      trace: {
        version: 1,
        startedAt: 1,
        completedAt: 2,
        emissions: [],
      },
    },
  },
  {
    type: "RUN_FINISHED",
    threadId: "thread-1",
    runId: "run-1",
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: "interrupt-1",
          reason: "input_required",
          message: "Pick a flight",
          toolCallId: "call-1",
          responseSchema: { type: "object" },
          metadata: { key: "pickFlight" },
        },
      ],
    },
  },
  { type: "REASONING_MESSAGE_CONTENT", messageId: "reasoning-1", delta: "Thinking" },
  { type: "RUN_ERROR", message: "planned failure", code: "provider_unavailable" },
];

describe("conversation checkpoint codec", () => {
  it("round-trips every persisted public event variant through a versioned envelope", () => {
    const encoded = encodeConversationCheckpoint(events);
    expect(JSON.parse(encoded)).toMatchObject({ version: 1 });
    expect(decodeConversationCheckpoint(encoded)).toEqual(events);
  });

  it.each([
    ["unversioned array", JSON.stringify(events)],
    ["unknown version", JSON.stringify({ version: 2, events: [] })],
    ["unknown event", JSON.stringify({ version: 1, events: [{ type: "OLD_EVENT" }] })],
    [
      "unknown event field",
      JSON.stringify({ version: 1, events: [{ type: "RUN_ERROR", message: "x", extra: true }] }),
    ],
    [
      "malformed nested message",
      JSON.stringify({
        version: 1,
        events: [
          {
            type: "MESSAGES_SNAPSHOT",
            messages: [
              {
                id: "m",
                role: "assistant",
                toolCalls: [{ id: "call", type: "function" }],
              },
            ],
          },
        ],
      }),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(() => decodeConversationCheckpoint(raw)).toThrow(ConversationCheckpointError);
  });

  it("rejects a checkpoint larger than the durable bound", () => {
    expect(() => decodeConversationCheckpoint("x".repeat(8 * 1024 * 1024 + 1))).toThrow(
      ConversationCheckpointError,
    );
  });
});
