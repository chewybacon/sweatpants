import { EventType } from "@ag-ui/core";
import { collectProjectionProgram } from "@sweatpants/foundation/projection";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  buildCheckpointSnapshotEventsFromFrames,
  completedConversationHydrateEvents,
  conversationReplayProjection,
  parseBufferedFrames,
  providerHistoryFromFrames,
  replayConversationViews,
  type ProjectionFrame,
} from "../projection.ts";
import {
  CONVERSATION_AUTHORITY_FRAME_TYPE,
  validateConversationSegment,
  type ConversationStreamEvent as StreamEvent,
} from "@sweatpants/chat-core";

function frames(...events: readonly StreamEvent[]): ProjectionFrame[] {
  return parseBufferedFrames([...events]);
}

const activitySnapshot: StreamEvent = {
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId: "activity-1",
  activityType: "example.activity",
  content: { value: "private activity" },
  replace: true,
};

const messageSnapshot: StreamEvent = {
  type: EventType.MESSAGES_SNAPSHOT,
  messages: [{ id: "user-1", role: "user", content: "hello" }],
};

describe("conversation replay projection", () => {
  it("replays one frame scan into provider and activity views", () => {
    const input = frames(messageSnapshot, activitySnapshot);
    const views = replayConversationViews(input);

    expect(views.providerMessages).toEqual([{ id: "user-1", role: "user", content: "hello" }]);
    expect(views.activitySnapshots).toHaveLength(1);
    expect(views.activitySnapshots[0]).toMatchObject({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "sweatpants:public-execution",
      replace: true,
    });
  });

  it("preserves activity ownership through checkpoint reconstruction", async () => {
    const input = frames({ ...activitySnapshot, subagentRunId: "child" });
    const checkpoint = await run(() => buildCheckpointSnapshotEventsFromFrames(input));
    expect(checkpoint).toContainEqual(
      expect.objectContaining({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        subagentRunId: "child",
      }),
    );
    expect(replayConversationViews(frames(...checkpoint)).activitySnapshots).toEqual(
      replayConversationViews(input).activitySnapshots,
    );
  });

  it("preserves tool-only ownership through a checkpoint and a resumed segment", async () => {
    const input = frames(
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "child-call",
        toolCallName: "ask",
        parentMessageId: "child-message",
        subagentRunId: "parent-owner",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "child-call",
        delta: "{}",
        subagentRunId: "parent-owner",
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "child-call", subagentRunId: "parent-owner" },
    );
    const checkpoint = await run(() => buildCheckpointSnapshotEventsFromFrames(input));
    expect(checkpoint).toContainEqual({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "child-message",
          role: "assistant",
          subagentRunId: "parent-owner",
          toolCalls: [
            { id: "child-call", type: "function", function: { name: "ask", arguments: "{}" } },
          ],
        },
      ],
    });
    expect(() =>
      validateConversationSegment([
        { type: EventType.RUN_STARTED, threadId: "thread", runId: "resumed" },
        ...checkpoint,
        { type: EventType.STATE_SNAPSHOT, snapshot: {} },
        {
          type: CONVERSATION_AUTHORITY_FRAME_TYPE,
          authority: {
            conversationId: "thread",
            revision: "1",
            state: "running",
            activeLogicalTurnId: "turn",
            activeExecutionId: "execution",
            latestCompletedExecutionId: null,
          },
        },
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "child-call",
          messageId: "result",
          role: "tool",
          content: "reply",
          subagentRunId: "parent-owner",
        },
        {
          type: CONVERSATION_AUTHORITY_FRAME_TYPE,
          authority: {
            conversationId: "thread",
            revision: "2",
            state: "idle",
            activeLogicalTurnId: null,
            activeExecutionId: null,
            latestCompletedExecutionId: "execution",
          },
        },
        {
          type: EventType.RUN_FINISHED,
          threadId: "thread",
          runId: "resumed",
          outcome: { type: "success" },
        },
      ]),
    ).not.toThrow();
  });

  it.each([
    {
      content: { status: "ok", output: { reply: "done" } },
      state: "output-available",
      result: { output: { reply: "done" } },
    },
    {
      content: { status: "error", errorText: "child failed" },
      state: "output-error",
      result: { errorText: "child failed" },
    },
  ])(
    "retains $state in activity checkpoints after a parked child resumes",
    async ({ content, state, result }) => {
      const pending = frames(
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "child",
          toolCallName: "ask",
          parentMessageId: "assistant",
          subagentRunId: "parent-owner",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "child", delta: "{}" },
        { type: EventType.TOOL_CALL_END, toolCallId: "child" },
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "execution:child",
          subagentRunId: "parent-owner",
          activityType: "sweatpants:public-execution",
          content: {
            version: 1,
            node: {
              nodeId: "execution:child",
              parentNodeId: "message:assistant",
              sequence: 0,
              kind: "tool-call",
              state: "input-available",
              presentation: "public",
              publicData: {
                kind: "tool-call",
                callId: "child",
                name: "ask",
                input: {},
                rawInput: "{}",
              },
            },
          },
          replace: true,
        },
      );
      const parked = await run(() => buildCheckpointSnapshotEventsFromFrames(pending));
      expect(replayConversationViews(frames(...parked)).activitySnapshots).toMatchObject([
        { content: { node: { state: "input-available" } } },
      ]);
      const completed = frames(...parked, {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "child",
        messageId: "result",
        role: "tool",
        subagentRunId: "parent-owner",
        content: JSON.stringify(content),
      });
      const views = replayConversationViews(completed);
      expect(views.activitySnapshots).toMatchObject([
        {
          messageId: "execution:child",
          subagentRunId: "parent-owner",
          content: { node: { state, publicData: result } },
        },
      ]);
      expect(views.providerMessages).toEqual(providerHistoryFromFrames(completed));
      expect(views.providerMessages).toContainEqual(
        expect.objectContaining({ role: "tool", toolCallId: "child" }),
      );
      const checkpoint = await run(() => buildCheckpointSnapshotEventsFromFrames(completed));
      expect(replayConversationViews(frames(...checkpoint))).toEqual(views);
    },
  );

  it("exposes semantic replay and materialization stages", () => {
    const input = frames(messageSnapshot, activitySnapshot);
    const outcome = collectProjectionProgram(
      () => conversationReplayProjection(input),
      (error) => (error instanceof Error ? error : new Error(String(error))),
    );

    expect(outcome.outcome.ok).toBe(true);
    expect(outcome.outcome.notes).toEqual([
      { kind: "frames-replayed", frames: 2, providerEvents: 1, activityEvents: 1 },
      { kind: "provider-history-materialized", messages: 1 },
      { kind: "activity-snapshots-materialized", snapshots: 1 },
    ]);
    expect(
      outcome.events.filter((event) => event.type === "enter").map((event) => event.path.join("/")),
    ).toEqual(["replay-frames", "provider-history", "activity-snapshots"]);
  });

  it("keeps provider-only projection cheap and excludes activity records", () => {
    const input = frames(messageSnapshot, activitySnapshot);

    expect(providerHistoryFromFrames(input)).toEqual([
      { id: "user-1", role: "user", content: "hello" },
    ]);
  });

  it("uses the shared views for checkpoint and completed hydration", async () => {
    const input = frames(messageSnapshot, activitySnapshot);
    const checkpoint = await run(() => buildCheckpointSnapshotEventsFromFrames(input));
    const completed = await run(() =>
      completedConversationHydrateEvents({
        frames: input,
        conversationId: "conversation-1",
        runId: "run-1",
        openInterrupts: [],
        elicits: [],
      }),
    );

    expect(checkpoint).toEqual([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: "user-1", role: "user", content: "hello" }],
      },
      expect.objectContaining({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
      }),
    ]);
    expect(completed).toEqual([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: "user-1", role: "user", content: "hello" }],
      },
      expect.objectContaining({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
      }),
      { type: EventType.STATE_SNAPSHOT, snapshot: {} },
    ]);
  });
});
