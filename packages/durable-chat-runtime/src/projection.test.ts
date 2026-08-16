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
} from "./projection.ts";
import type { StreamEvent } from "./handler/types.ts";

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
