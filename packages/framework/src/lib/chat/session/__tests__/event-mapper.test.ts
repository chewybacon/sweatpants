import { describe, expect, it } from "vitest";
import { run, createChannel, spawn, each, resource, type Operation, type Stream } from "effection";
import { mapStreamEventsToPatches } from "../event-mapper.ts";
import type { StreamEvent } from "../streaming.ts";
import type { ChatPatch } from "../../patches/index.ts";

async function mapEvents(events: StreamEvent[]): Promise<{
  patches: ChatPatch[];
  result: Awaited<ReturnType<typeof runMapEvents>>["result"];
}> {
  const result = await runMapEvents(events);
  return result;
}

function runMapEvents(events: StreamEvent[]) {
  return run(function* () {
    const patches = createChannel<ChatPatch, void>();
    const collectedPatches: ChatPatch[] = [];
    const eventStream: Stream<unknown, void> = resource(function* (provide) {
      let index = 0;

      yield* provide({
        *next(): Operation<IteratorResult<unknown, void>> {
          if (index >= events.length) {
            return { done: true, value: undefined };
          }

          const event = events[index]!;
          index += 1;
          return {
            done: false,
            value: {
              lsn: index,
              event,
            },
          };
        },
      });
    });

    yield* spawn(function* () {
      for (const patch of yield* each(patches)) {
        collectedPatches.push(patch);
        yield* each.next();
      }
    });

    const resultTask = yield* spawn(function* () {
      return yield* mapStreamEventsToPatches(eventStream, patches);
    });
    const result = yield* resultTask;
    yield* patches.close();

    return {
      patches: collectedPatches,
      result,
    };
  });
}

describe("mapStreamEventsToPatches", () => {
  it("maps AG-UI assistant text lifecycle into streaming text patches", async () => {
    const { patches, result } = await mapEvents([
      {
        type: "ag_ui_text_message_start",
        messageId: "assistant:final:run-1",
        role: "assistant",
      },
      {
        type: "ag_ui_text_message_content",
        messageId: "assistant:final:run-1",
        delta: "Hello",
      },
      {
        type: "ag_ui_text_message_content",
        messageId: "assistant:final:run-1",
        delta: " world",
      },
      {
        type: "ag_ui_text_message_end",
        messageId: "assistant:final:run-1",
      },
      {
        type: "ag_ui_run_finished",
        run: { threadId: "thread-1", runId: "run-1" },
      },
    ]);

    expect(patches.filter((patch) => patch.type === "streaming_text")).toEqual([
      { type: "streaming_text", content: "Hello" },
      { type: "streaming_text", content: " world" },
    ]);
    expect(result).toMatchObject({ type: "complete", text: "Hello world" });
  });

  it("keeps post-tool assistant text separate from the assistant tool-call host", async () => {
    const { result } = await mapEvents([
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant:final:run-1",
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant:final:run-1",
        delta: "Let me check.",
      },
      {
        type: "TEXT_MESSAGE_END",
        messageId: "assistant:final:run-1",
      },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call-ordering",
        toolCallName: "pick_card",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "call-ordering",
        delta: '{"count":3}',
      },
      {
        type: "TOOL_CALL_END",
        toolCallId: "call-ordering",
      },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tool:call-ordering",
        toolCallId: "call-ordering",
        toolCallName: "pick_card",
        content: "Selected Queen of Hearts",
        role: "tool",
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant:final:run-1b",
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant:final:run-1b",
        delta: "You picked the Queen of Hearts!",
      },
      {
        type: "TEXT_MESSAGE_END",
        messageId: "assistant:final:run-1b",
      },
      {
        type: "RUN_FINISHED",
        threadId: "thread-1",
        runId: "run-1",
        outcome: { type: "success" },
      },
    ]);

    expect(result).toMatchObject({
      type: "complete",
      text: "You picked the Queen of Hearts!",
      conversationState: {
        messages: [
          {
            role: "assistant",
            content: "Let me check.",
            tool_calls: [
              {
                id: "call-ordering",
              },
            ],
          },
          {
            role: "tool",
            content: "Selected Queen of Hearts",
            tool_call_id: "call-ordering",
          },
        ],
        assistantContent: "You picked the Queen of Hearts!",
      },
    });
  });

  it("keeps sequential tool iterations separately hosted in conversation state", async () => {
    const { result } = await mapEvents([
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant:pre-a",
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant:pre-a",
        delta: "Before A.",
      },
      {
        type: "TEXT_MESSAGE_END",
        messageId: "assistant:pre-a",
      },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call-A",
        toolCallName: "first_tool",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "call-A",
        delta: '{"value":"a"}',
      },
      {
        type: "TOOL_CALL_END",
        toolCallId: "call-A",
      },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tool:call-A",
        toolCallId: "call-A",
        toolCallName: "first_tool",
        content: "result A",
        role: "tool",
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant:pre-b",
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant:pre-b",
        delta: "Between A and B.",
      },
      {
        type: "TEXT_MESSAGE_END",
        messageId: "assistant:pre-b",
      },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call-B",
        toolCallName: "second_tool",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "call-B",
        delta: '{"value":"b"}',
      },
      {
        type: "TOOL_CALL_END",
        toolCallId: "call-B",
      },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tool:call-B",
        toolCallId: "call-B",
        toolCallName: "second_tool",
        content: "result B",
        role: "tool",
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant:final",
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant:final",
        delta: "Done.",
      },
      {
        type: "TEXT_MESSAGE_END",
        messageId: "assistant:final",
      },
      {
        type: "RUN_FINISHED",
        threadId: "thread-1",
        runId: "run-1",
        outcome: { type: "success" },
      },
    ]);

    expect(result.type).toBe("complete");
    const messages = result.type === "complete" ? result.conversationState?.messages ?? [] : [];
    const assistantHosts = messages.filter(
      (message) => message.role === "assistant" && message.tool_calls?.length,
    );

    expect(assistantHosts.map((message) => message.tool_calls!.map((toolCall) => toolCall.id))).toEqual([
      ["call-A"],
      ["call-B"],
    ]);
    expect(assistantHosts.map((message) => message.content)).toEqual([
      "Before A.",
      "Between A and B.",
    ]);
    expect(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual([
      "call-A",
      "call-B",
    ]);
    expect(result).toMatchObject({ type: "complete", text: "Done." });
  });

  it("maps AG-UI tool lifecycle into one tool_call_start patch", async () => {
    const { patches, result } = await mapEvents([
      {
        type: "ag_ui_tool_call_start",
        toolCallId: "call-1",
        toolCallName: "echo",
      },
      {
        type: "ag_ui_tool_call_args",
        toolCallId: "call-1",
        delta: '{"input":',
      },
      {
        type: "ag_ui_tool_call_args",
        toolCallId: "call-1",
        delta: '"hello"}',
      },
      {
        type: "ag_ui_tool_call_end",
        toolCallId: "call-1",
      },
      {
        type: "ag_ui_tool_call_result",
        toolCallId: "call-1",
        toolCallName: "echo",
        content: "Mock result for: hello",
      },
      {
        type: "ag_ui_run_finished",
        run: { threadId: "thread-1", runId: "run-1" },
      },
    ]);

    expect(patches.filter((patch) => patch.type === "tool_call_start")).toEqual([
      {
        type: "tool_call_start",
        call: {
          id: "call-1",
          name: "echo",
          arguments: '{"input":"hello"}',
        },
      },
    ]);
    expect(patches).toContainEqual({
      type: "elicit_complete",
      callId: "call-1",
    });
    expect(result).toMatchObject({
      type: "complete",
      toolCalls: [{ id: "call-1", name: "echo", arguments: { input: "hello" } }],
      toolResults: [{ id: "call-1", name: "echo", content: "Mock result for: hello" }],
    });
  });

  it("clears elicit state when an AG-UI tool error is mapped", async () => {
    const { patches } = await mapEvents([
      {
        type: "ag_ui_tool_call_error",
        toolCallId: "call-error",
        toolCallName: "explode",
        message: "boom",
      },
      {
        type: "ag_ui_run_finished",
        run: { threadId: "thread-1", runId: "run-1" },
      },
    ]);

    expect(patches).toContainEqual({
      type: "tool_call_error",
      id: "call-error",
      error: "boom",
    });
    expect(patches).toContainEqual({
      type: "elicit_complete",
      callId: "call-error",
    });
  });

  it("maps direct resumed elicit_request events into elicit patches", async () => {
    const { patches, result } = await mapEvents([
      {
        type: "elicit_request",
        sessionId: "session-1",
        callId: "call-elicit",
        toolName: "book_flight",
        elicitId: "elicit-2",
        key: "pickSeat",
        message: "Select your seat",
        schema: {
          type: "object",
          "x-model-context": {
            seatMap: { rows: 1, seatsPerRow: ["A"], taken: [] },
          },
        },
      },
    ]);

    expect(patches).toContainEqual({
      type: "elicit_start",
      callId: "call-elicit",
      toolName: "book_flight",
    });
    expect(patches).toContainEqual({
      type: "elicit",
      callId: "call-elicit",
      elicit: {
        elicitId: "elicit-2",
        sessionId: "session-1",
        key: "pickSeat",
        message: "Select your seat",
        schema: {
          type: "object",
          "x-model-context": {
            seatMap: { rows: 1, seatsPerRow: ["A"], taken: [] },
          },
        },
        context: {
          seatMap: { rows: 1, seatsPerRow: ["A"], taken: [] },
        },
        status: "pending",
        timestamp: expect.any(Number),
      },
    });
    expect(result).toMatchObject({
      type: "elicit",
      pendingElicitations: [
        {
          callId: "call-elicit",
          toolName: "book_flight",
          sessionId: "session-1",
          elicitId: "elicit-2",
          key: "pickSeat",
          message: "Select your seat",
        },
      ],
    });
  });

  it("reconstructs elicit result state from AG-UI state snapshots", async () => {
    const { patches, result } = await mapEvents([
      {
        type: "ag_ui_state_snapshot",
        run: {
          threadId: "thread-1",
          runId: "run-1",
        },
        state: {
          pendingClientActions: [
            {
              toolCallId: "call-elicit",
              toolName: "confirm",
              kind: "elicit",
              sessionId: "session-1",
              elicitId: "elicit-1",
              key: "confirmAction",
              message: "Confirm?",
              schema: { type: "object" },
            },
          ],
        },
      },
      {
        type: "ag_ui_checkpoint",
        checkpoint: {
          run: { threadId: "thread-1", runId: "run-1" },
          messages: { messages: [] },
          state: {
            assistantContent: "",
            toolCalls: [],
            serverToolResults: [],
          },
        },
      },
    ]);

    expect(patches).toContainEqual({
      type: "elicit_start",
      callId: "call-elicit",
      toolName: "confirm",
    });
    expect(patches).toContainEqual({
      type: "elicit",
      callId: "call-elicit",
      elicit: {
        elicitId: "elicit-1",
        sessionId: "session-1",
        key: "confirmAction",
        message: "Confirm?",
        schema: { type: "object" },
        context: undefined,
        status: "pending",
        timestamp: expect.any(Number),
      },
    });
    expect(result).toMatchObject({
      type: "elicit",
      pendingElicitations: [
        {
          callId: "call-elicit",
          toolName: "confirm",
          sessionId: "session-1",
          elicitId: "elicit-1",
          key: "confirmAction",
          message: "Confirm?",
          schema: { type: "object" },
        },
      ],
    });
  });
});
