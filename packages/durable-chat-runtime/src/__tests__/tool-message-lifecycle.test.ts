import { describe, expect, it } from "vitest";
import { run } from "effection";
import { assertJson, type Json } from "@sweatpants/foundation";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import { LOW_CHECKPOINT_TARGETS } from "@sweatpants/history-store";
import {
  createChatProjection,
  foldAGUIEvents,
  materializeChatMessages,
  projectionFromPublicRoots,
  decodePublicProjectionRoot,
} from "@sweatpants/chat-core";
import { projectRecords } from "../durable-handler/program-driver/program-driver-chat-record-projection.ts";
import { indexChatJournal } from "../durable-handler/program-driver/program-driver-chat-journal-index.ts";
import {
  hydratePublicRoots,
  persistConversationCheckpoint,
  readAllPublicRootsForModel,
} from "../conversation-persistence.ts";
import { withConversationStore } from "./with-conversation-store.ts";

function record(payload: DurableSemanticRecord["payload"], offset: number): DurableSemanticRecord {
  return { offset: String(offset), eventId: `event-${offset}`, sessionId: "session", payload };
}
function emission(eventType: string, payload: Json, offset: number) {
  return record(
    {
      type: "DurableEmission",
      taskId: "root",
      actionIndex: offset,
      emissionIndex: offset,
      descriptor: { eventType, payload },
      descriptorDigest: `digest-${offset}`,
    },
    offset,
  );
}
const idle = {
  state: "idle" as const,
  checkpoint: null,
  terminalHistory: null,
  activeLogicalTurnId: null,
  activeExecutionId: null,
  latestCompletedExecutionId: null,
  activeSegment: null,
  activeCommand: null,
  deletedAt: null,
  ownerTransition: { kind: "preserve" as const },
};

function terminal(kind: string, callId: string, offset: number) {
  if (kind === "cancelled")
    return record({ type: "TaskClosed", taskId: "root", outcome: { status: "cancelled" } }, offset);
  if (kind === "interrupted")
    return record(
      {
        type: "TaskClosed",
        taskId: "root",
        outcome: { status: "error", error: { code: "interrupted", message: "interrupted" } },
      },
      offset,
    );
  return emission(
    "tool_completed",
    {
      callId,
      tool: "ask",
      result:
        kind === "failed"
          ? { status: "error", error: { code: "failed", message: "failed" } }
          : "answer",
      failed: kind === "failed",
    },
    offset,
  );
}

describe("synthetic tool message lifecycle", () => {
  it.each(["completed", "failed", "cancelled", "interrupted"])(
    "seals the owner after %s, including a resumed segment",
    async (kind) => {
      const start = emission("tool_started", { callId: "call", tool: "ask", input: {} }, 0);
      const end = terminal(kind, "call", 1);
      const starts = projectRecords([start], indexChatJournal([start]));
      const ends = projectRecords([end], indexChatJournal([start, end]));
      const live = foldAGUIEvents(foldAGUIEvents(createChatProjection(), starts), ends);
      expect(live.nodes.get("message:root:call")?.node.state).toBe("done");
      expect(materializeChatMessages(live)).toHaveLength(1);
      expect(materializeChatMessages(live)[0].parts.map((p) => p.type)).toEqual(["tool-call"]);
      const store = createMemoryConversationStore();
      await run(function* () {
        yield* store.compareAndSwapHead("conversation", null, null, idle);
        for (const [i, events] of [starts, ends].entries()) {
          const result = yield* withConversationStore(store, () =>
            persistConversationCheckpoint({
              conversationId: "conversation",
              causeKey: String(i),
              cause: { kind: "test" },
              roots: events.map((event) => assertJson(event)),
              proposal: idle,
              createdAt: i,
              targets: LOW_CHECKPOINT_TARGETS,
            }),
          );
          const hot = hydratePublicRoots(result.checkpoint).map((root) =>
            decodePublicProjectionRoot(root),
          );
          if (i === 0) expect(hot.some((r) => r.state === "mutable")).toBe(true);
          else {
            expect(hot.filter((r) => r.state === "mutable")).toEqual([]);
            const roots = yield* withConversationStore(store, () =>
              readAllPublicRootsForModel("conversation", result.checkpoint, 64 * 1024 * 1024),
            );
            const restored = materializeChatMessages(
              projectionFromPublicRoots(roots.map((root) => decodePublicProjectionRoot(root))),
            );
            expect(restored.map((m) => ({ id: m.id, parts: m.parts }))).toEqual(
              materializeChatMessages(live).map((m) => ({ id: m.id, parts: m.parts })),
            );
          }
        }
      });
    },
  );
});

it("archives completed owners under pressure and restores every tool without empty messages", async () => {
  const store = createMemoryConversationStore();
  const records: DurableSemanticRecord[] = [];
  await run(function* () {
    yield* store.compareAndSwapHead("pressure", null, null, idle);
    for (let i = 0; i < 20; i++) {
      const batch = [
        emission("tool_started", { callId: `call-${i}`, tool: "ask", input: {} }, i * 2),
        terminal("completed", `call-${i}`, i * 2 + 1),
      ];
      records.push(...batch);
      const events = projectRecords(batch, indexChatJournal(records));
      const result = yield* withConversationStore(store, () =>
        persistConversationCheckpoint({
          conversationId: "pressure",
          causeKey: String(i),
          cause: { kind: "test" },
          roots: events.map((event) => assertJson(event)),
          proposal: idle,
          createdAt: i,
          targets: LOW_CHECKPOINT_TARGETS,
        }),
      );
      const hot = hydratePublicRoots(result.checkpoint).map((root) =>
        decodePublicProjectionRoot(root),
      );
      expect(hot.filter((r) => r.state === "mutable")).toEqual([]);
      expect(hot.length).toBeLessThanOrEqual(LOW_CHECKPOINT_TARGETS.spill.maxRoots);
      const visible = materializeChatMessages(projectionFromPublicRoots(hot));
      expect(visible.every((m) => m.parts.length > 0)).toBe(true);
      const all = yield* withConversationStore(store, () =>
        readAllPublicRootsForModel("pressure", result.checkpoint, 64 * 1024 * 1024),
      );
      const restored = materializeChatMessages(
        projectionFromPublicRoots(all.map((root) => decodePublicProjectionRoot(root))),
      );
      expect(restored).toHaveLength(i + 1);
      expect(restored.every((m) => m.parts.length === 1 && m.parts[0].type === "tool-call")).toBe(
        true,
      );
    }
  });
});

it("completion closes only its owner and leaves another pending interaction open", () => {
  const records = [
    emission("tool_started", { callId: "first", tool: "ask", input: {} }, 0),
    emission("tool_started", { callId: "second", tool: "ask", input: {} }, 1),
    terminal("completed", "first", 2),
  ];
  const state = foldAGUIEvents(
    createChatProjection(),
    projectRecords(records, indexChatJournal(records)),
  );
  expect(state.nodes.get("message:root:first")?.node.state).toBe("done");
  expect(state.nodes.get("message:root:second")?.node.state).toBe("streaming");
});

it("creates and closes the owner when only a completion emission exists", () => {
  const records = [terminal("completed", "call", 0)];
  const state = foldAGUIEvents(
    createChatProjection(),
    projectRecords(records, indexChatJournal(records)),
  );
  expect(state.nodes.get("message:root:call")?.node.state).toBe("done");
  expect(materializeChatMessages(state)).toHaveLength(1);
});
