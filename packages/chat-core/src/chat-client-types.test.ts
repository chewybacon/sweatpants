import { describe, expect, it } from "vitest";
import type {
  ChatUIActivityPart,
  ChatUIStructuredOutputPart,
  ChatUIToolCallPart,
} from "./chat-client-types.ts";

describe("state-discriminated Chat UI parts", () => {
  it("keeps lifecycle variants constructible with only their valid fields", () => {
    const streaming: ChatUIToolCallPart = {
      type: "tool-call",
      id: "tool-node",
      callId: "call-1",
      name: "lookup",
      state: "input-streaming",
      parts: [],
    };
    const available: ChatUIToolCallPart = {
      ...streaming,
      state: "input-available",
      input: { query: "Paris" },
    };
    const complete: ChatUIStructuredOutputPart = {
      type: "structured-output",
      id: "structured-1",
      status: "complete",
      raw: '{"ok":true}',
      data: { ok: true },
    };
    const activity: ChatUIActivityPart = {
      type: "activity",
      id: "activity-1",
      activityType: "demo",
      state: "running",
      presentation: "public",
      parts: [],
    };

    expect([streaming.state, available.state, complete.status, activity.state]).toEqual([
      "input-streaming",
      "input-available",
      "complete",
      "running",
    ]);
  });

  it("rejects fields that do not belong to a narrowed lifecycle state", () => {
    // @ts-expect-error input-available cannot carry output.
    const invalidTool: ChatUIToolCallPart = {
      type: "tool-call",
      id: "tool-node",
      callId: "call-1",
      name: "lookup",
      state: "input-available",
      input: {},
      output: {},
      parts: [],
    };
    void invalidTool;

    // @ts-expect-error error state cannot carry complete data.
    const invalidStructured: ChatUIStructuredOutputPart = {
      type: "structured-output",
      id: "structured-1",
      status: "error",
      raw: "{}",
      data: {},
      errorText: "failed",
    };
    void invalidStructured;
  });
});
