import { describe, expect, it } from "vitest";
import type {
  ConversationWindowFrame,
  FramePipelineFactory,
  PublicMessageRoot,
} from "@sweatpants/chat-core";
import { LiveChatCompactor } from "../live-compactor.ts";

const unusedPipeline: FramePipelineFactory = () => {
  throw new Error("window-only test must not construct a text pipeline");
};

function root(id: string, position: string, role: "user" | "assistant"): PublicMessageRoot {
  return {
    rootId: `root:${id}`,
    position,
    kind: "message",
    state: "sealed",
    attribution: {},
    message: { id, role, content: id },
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

describe("LiveChatCompactor window layers", () => {
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
