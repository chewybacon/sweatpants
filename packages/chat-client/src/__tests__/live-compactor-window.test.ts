import { describe, expect, it } from "vitest";
import { call, run } from "effection";
import { EventType } from "@ag-ui/core";
import {
  emptyFrame,
  type Frame,
  type FramePipeline,
  type ConversationWindowFrame,
  type FramePipelineFactory,
  type PublicMessageRoot,
} from "@sweatpants/chat-core";
import { LiveChatCompactor } from "../live-compactor.ts";

const unusedPipeline: FramePipelineFactory = () => {
  throw new Error("window-only test must not construct a text pipeline");
};

function root(
  id: string,
  position: string,
  role: "user" | "assistant",
  content = id,
): PublicMessageRoot {
  return {
    rootId: `root:${id}`,
    position,
    kind: "message",
    state: "sealed",
    attribution: {},
    message: { id, role, content },
    placement: { type: "root", sequence: Number(position) },
  };
}

function window(
  lineageId: string,
  hotRoots: readonly PublicMessageRoot[],
  options: {
    mode?: "reset" | "continue";
    catchup?: readonly PublicMessageRoot[];
    cursor?: string | null;
  } = {},
): ConversationWindowFrame {
  return {
    type: "sweatpants.conversation-window.v1",
    conversationId: "conversation-1",
    lineageId,
    basisRevision: "1",
    windowToken: "token",
    windowMode: options.mode ?? "reset",
    archiveFrontierOrdinal: "0",
    nextPublicPosition: "20",
    hotRoots,
    sealedCatchupRoots: options.catchup ?? [],
    applicationState: {},
    olderHistoryCursor: options.cursor ?? null,
  };
}

interface SuspendedPipeline {
  readonly frame: Frame;
  readonly pipeline: FramePipeline;
  readonly started: Promise<void>;
  release(): void;
}

function suspendedPipeline(frame: Frame = emptyFrame()): SuspendedPipeline {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pullStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pipeline: FramePipeline = {
    frame,
    hasPending: true,
    isDone: false,
    push() {},
    pull: () =>
      call(async () => {
        started();
        await released;
        return frame;
      }),
    flush: () =>
      call(async () => {
        started();
        await released;
        return frame;
      }),
    reset() {},
  };
  return { frame, pipeline, started: pullStarted, release };
}

describe("LiveChatCompactor window layers", () => {
  it("does not apply a suspended old presentation frame after window replacement", async () => {
    const suspended = suspendedPipeline();
    const pipeline = suspended.pipeline;
    const compactor = new LiveChatCompactor(() => pipeline);
    compactor.ingest({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "old-message",
      role: "assistant",
    });
    compactor.ingest({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "old-message",
      delta: "old presentation",
    });

    const pulling = run(() => compactor.pull());
    await suspended.started;
    compactor.applyWindow(window("lineage-2", [root("new-message", "1", "assistant")]));
    suspended.release();

    await expect(pulling).resolves.toBeUndefined();
    expect(compactor.materialize().map((message) => message.id)).toEqual(["new-message"]);
  });

  it("fences suspended work across a projection reset", async () => {
    const suspended = suspendedPipeline();
    const compactor = new LiveChatCompactor(() => suspended.pipeline);
    compactor.ingest({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "reset-message",
      role: "assistant",
    });
    compactor.ingest({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "reset-message",
      delta: "stale presentation",
    });

    const pulling = run(() => compactor.pull());
    await suspended.started;
    compactor.reset();
    suspended.release();

    await expect(pulling).resolves.toBeUndefined();
    expect(compactor.materialize()).toEqual([]);
  });

  it("fences suspended flush work even when the authoritative message keeps its identity", async () => {
    const oldFrame: Frame = {
      ...emptyFrame(),
      blocks: [
        {
          id: "old-block",
          type: "text",
          raw: "old presentation",
          rendered: "STALE_RENDERED_FRAME",
          status: "streaming",
          renderPass: "quick",
        },
      ],
    };
    const oldSuspended = suspendedPipeline(oldFrame);
    const replacementSuspended = suspendedPipeline();
    let factoryCalls = 0;
    const compactor = new LiveChatCompactor(() => {
      const suspended = [oldSuspended, replacementSuspended][factoryCalls++];
      if (!suspended) throw new Error("unexpected presentation pipeline");
      return suspended.pipeline;
    });
    compactor.ingest({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "same-message",
      role: "assistant",
    });
    compactor.ingest({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "same-message",
      delta: "old presentation",
    });

    const pulling = run(() => compactor.pull(true));
    await oldSuspended.started;
    compactor.applyWindow(
      window("lineage-2", [root("same-message", "1", "assistant", "authoritative content")]),
    );
    const replacementPull = run(() => compactor.pull());
    await replacementSuspended.started;
    oldSuspended.release();

    await expect(pulling).resolves.toBeUndefined();
    // A late terminal tick must reuse the replacement pipeline. If stale flush
    // cleanup deleted it, bufferText would construct a third pipeline here.
    compactor.ingest({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "same-message",
    });
    expect(factoryCalls).toBe(2);
    replacementSuspended.release();
    await expect(replacementPull).resolves.toBeUndefined();
    const message = compactor.materialize()[0]!;
    expect(message.id).toBe("same-message");
    expect(message.parts[0]).toMatchObject({
      type: "text",
      text: "authoritative content",
    });
    expect(message.parts[0]).not.toHaveProperty("rendered", "STALE_RENDERED_FRAME");
  });

  it("merges sealed pages and hot roots by durable numerical position", () => {
    const compactor = new LiveChatCompactor(unusedPipeline);
    compactor.applyWindow(window("lineage-1", [root("new", "10", "assistant")]));
    compactor.applyHistoryPage({ roots: [root("old", "9", "user")], nextOlderCursor: null });
    expect(compactor.materialize().map((message) => message.id)).toEqual(["old", "new"]);
  });

  it("folds continue catch-up before replacing hot roots and is page-idempotent", () => {
    const compactor = new LiveChatCompactor(unusedPipeline);
    const previousHot = root("previous", "9", "user");
    compactor.applyWindow(window("lineage-1", [previousHot]));
    compactor.applyHistoryPage({ roots: [root("old", "1", "user")], nextOlderCursor: null });
    compactor.applyWindow(
      window("lineage-1", [root("current", "10", "assistant")], {
        mode: "continue",
        catchup: [previousHot],
      }),
    );
    compactor.applyHistoryPage({ roots: [root("old", "1", "user")], nextOlderCursor: null });
    expect(compactor.materialize().map((message) => message.id)).toEqual([
      "old",
      "previous",
      "current",
    ]);
  });

  it("clears all server root layers on lineage change", () => {
    const compactor = new LiveChatCompactor(unusedPipeline);
    compactor.applyWindow(window("lineage-1", [root("one", "1", "user")]));
    compactor.applyHistoryPage({ roots: [root("zero", "0", "user")], nextOlderCursor: null });
    compactor.applyWindow(window("lineage-2", [root("replacement", "2", "assistant")]));
    expect(compactor.materialize().map((message) => message.id)).toEqual(["replacement"]);
  });
});
