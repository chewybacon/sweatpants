import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../handler/types.ts";
import {
  ConversationCheckpointError,
  decodeConversationCheckpoint,
  encodeConversationCheckpoint,
} from "../conversation-checkpoint.ts";

const events: StreamEvent[] = [
  {
    type: EventType.RUN_STARTED,
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
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [{ id: "tool-1", role: "tool", content: "done", toolCallId: "call-1" }],
  },
  {
    type: EventType.STATE_SNAPSHOT,
    snapshot: {
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
  { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-2", role: "assistant" },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "assistant-2", delta: "Booked." },
  { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-2" },
  { type: EventType.TOOL_CALL_START, toolCallId: "call-2", toolCallName: "notify" },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-2", delta: "{}" },
  { type: EventType.TOOL_CALL_END, toolCallId: "call-2" },
  {
    type: EventType.TOOL_CALL_RESULT,
    messageId: "tool-2",
    toolCallId: "call-2",
    content: "ok",
    role: "tool",
  },
  {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: "activity-record-1",
    activityType: "sweatpants:public-execution",
    replace: true,
    content: {
      version: 1,
      node: {
        nodeId: "activity-1",
        parentNodeId: null,
        sequence: 0,
        kind: "activity",
        state: "running",
        presentation: "opaque",
        publicData: { kind: "activity", activityType: "opaque-execution" },
      },
    },
  },
  {
    type: EventType.RUN_FINISHED,
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
  { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reasoning-1", delta: "Thinking" },
  { type: EventType.RUN_ERROR, message: "planned failure", code: "provider_unavailable" },
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
    ["frontend-local envelope field", JSON.stringify({ version: 1, events: [], localRenders: [] })],
    ["legacy replay envelope field", JSON.stringify({ version: 1, events: [], pluginReplay: {} })],
    ["unknown event", JSON.stringify({ version: 1, events: [{ type: "OLD_EVENT" }] })],
    [
      "unknown event field",
      JSON.stringify({
        version: 1,
        events: [{ type: EventType.RUN_ERROR, message: "x", extra: true }],
      }),
    ],
    [
      "malformed nested message",
      JSON.stringify({
        version: 1,
        events: [
          {
            type: EventType.MESSAGES_SNAPSHOT,
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

  it("rejects frontend render state in a host tree checkpoint", () => {
    expect(() =>
      encodeConversationCheckpoint([
        {
          type: "HOST_TREE_SNAPSHOT",
          snapshot: {
            messages: [
              {
                type: "message",
                id: "message-1",
                placement: { nodeId: "message-1", parentNodeId: null, sequence: 0 },
                role: "assistant",
                parts: [
                  {
                    type: "tool-call",
                    id: "part-1",
                    callId: "call-1",
                    name: "pick",
                    arguments: {},
                    state: "running",
                    execution: {
                      type: "execution",
                      placement: { nodeId: "execution-1", parentNodeId: "message-1", sequence: 0 },
                      executionId: "execution-1",
                      presentation: "public",
                      status: "running",
                      children: [
                        {
                          type: "elicit",
                          placement: {
                            nodeId: "elicit-1",
                            parentNodeId: "execution-1",
                            sequence: 0,
                          },
                          elicitId: "elicit-1",
                          bindingId: "binding-1",
                          key: "pick",
                          message: "Pick",
                          status: "pending",
                          renders: [{ nativeHandle: "not-host-data" }],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        } as unknown as StreamEvent,
      ]),
    ).toThrow(ConversationCheckpointError);
  });

  it("rejects frontend fields even when the render collection is empty", () => {
    expect(() =>
      encodeConversationCheckpoint([
        {
          type: "HOST_TREE_SNAPSHOT",
          snapshot: {
            messages: [
              {
                type: "message",
                id: "message-1",
                placement: { nodeId: "message-1", parentNodeId: null, sequence: 0 },
                role: "assistant",
                parts: [
                  {
                    type: "tool-call",
                    id: "part-1",
                    callId: "call-1",
                    name: "pick",
                    arguments: {},
                    state: "running",
                    execution: {
                      type: "execution",
                      placement: { nodeId: "execution-1", parentNodeId: "message-1", sequence: 0 },
                      executionId: "execution-1",
                      presentation: "public",
                      status: "running",
                      children: [
                        {
                          type: "elicit",
                          placement: {
                            nodeId: "elicit-1",
                            parentNodeId: "execution-1",
                            sequence: 0,
                          },
                          elicitId: "elicit-1",
                          bindingId: "binding-1",
                          key: "pick",
                          message: "Pick",
                          status: "pending",
                          renders: [],
                          response: "local-only",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        } as unknown as StreamEvent,
      ]),
    ).toThrow(ConversationCheckpointError);
  });

  it("rejects a checkpoint larger than the durable bound", () => {
    expect(() => decodeConversationCheckpoint("x".repeat(8 * 1024 * 1024 + 1))).toThrow(
      ConversationCheckpointError,
    );
  });
});
