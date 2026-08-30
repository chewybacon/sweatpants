import { call, run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import type { Json } from "@sweatpants/foundation";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import { createCapabilityKeyring } from "./capabilities.ts";
import { createMemoryExecutionStore } from "./memory.ts";
import { createStoredShellDrivers } from "./stored-shell.ts";
import type { PrivateSegmentPointer } from "./store.ts";

const manifest: DurableProgramManifest = {
  programId: "archive-linearity.fixture",
  version: "1",
  digest: "a".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};

const sessionId = "archive-session";
const journalId = "archive-linearity";
const executionId = `authority:${journalId}`;
const turnCount = 6;

interface PointerControl {
  readonly journalHead: PrivateSegmentPointer | null;
  readonly replayHead: PrivateSegmentPointer | null;
}

function eventIdOf(entry: Json): string {
  return (entry as { eventId: string }).eventId;
}

function taskIdOf(entry: Json): string {
  return (entry as { payload: { taskId: string } }).payload.taskId;
}

describe("stored authority replay archive", () => {
  it("archives each evicted record exactly once across sequential root trees", async () => {
    const store = createMemoryExecutionStore();
    const drivers = createStoredShellDrivers(store, {
      journalId,
      keyring: createCapabilityKeyring("archive-test", [
        { keyId: "test", secret: "archive-test-secret-material-32-bytes" },
      ]),
    });

    const readAll = function* (
      kind: "journal" | "replay",
      taskId: string,
      head: PrivateSegmentPointer | null,
    ): Operation<Json[]> {
      if (!head) return [];
      const stream =
        kind === "journal"
          ? yield* store.readJournal({ executionId, taskId, head })
          : yield* store.readReplay({ executionId, taskId, head });
      return yield* call(async () => {
        const all: Json[] = [];
        for await (const chunk of stream) all.push(...chunk);
        return all;
      });
    };

    await run(function* () {
      for (let turn = 0; turn < turnCount; turn += 1) {
        const taskId = `turn-${turn}/root`;
        const opened = yield* drivers.authority.command({
          type: "execution.open-task",
          request: {
            sessionId,
            turnId: `turn-${turn}`,
            taskId,
            manifest,
            input: null,
            executionEpoch: 1,
            attachmentId: `attachment-${turn}`,
            audience: "workflow-host",
          },
        });
        yield* drivers.authority.command({
          type: "execution.append-emission",
          request: {
            sessionId,
            taskId,
            actionIndex: 0,
            descriptor: { eventType: "progress", payload: { turn } },
            programCapability: opened.programCapability,
          },
        });
        yield* drivers.authority.command({
          type: "execution.complete-task",
          request: {
            sessionId,
            taskId,
            actionIndex: 1,
            outcome: { status: "ok", value: `done-${turn}` },
            programCapability: opened.programCapability,
          },
        });
      }

      const control = yield* store.loadControl(executionId);
      expect(control).not.toBeNull();
      const pointers = control!.control as unknown as PointerControl;
      const journalEntries = yield* readAll("journal", "authority", pointers.journalHead);
      const archived = yield* readAll("replay", "authority-archive", pointers.replayHead);
      expect(journalEntries.length).toBeGreaterThan(0);
      expect(archived.length).toBeGreaterThan(0);

      // Regression: every archived event is archived exactly once.
      const archivedIds = archived.map(eventIdOf);
      expect(new Set(archivedIds).size).toBe(archivedIds.length);

      // The archive holds exactly the records of evicted (non-latest) trees.
      const latestTask = `turn-${turnCount - 1}/root`;
      const expectedArchived = journalEntries
        .filter((entry) => taskIdOf(entry) !== latestTask)
        .map(eventIdOf);
      expect([...archivedIds].sort()).toEqual([...expectedArchived].sort());

      // Linearity: the archive is strictly smaller than the complete journal.
      expect(archived.length).toBeLessThan(journalEntries.length);
    });
  });

  it("does not grow the archive or commit on idempotent replays", async () => {
    const store = createMemoryExecutionStore();
    const drivers = createStoredShellDrivers(store, {
      journalId,
      keyring: createCapabilityKeyring("archive-test", [
        { keyId: "test", secret: "archive-test-secret-material-32-bytes" },
      ]),
    });
    await run(function* () {
      const opened = yield* drivers.authority.command({
        type: "execution.open-task",
        request: {
          sessionId,
          turnId: "turn-0",
          taskId: "turn-0/root",
          manifest,
          input: null,
          executionEpoch: 1,
          attachmentId: "attachment-0",
          audience: "workflow-host",
        },
      });
      const complete = {
        type: "execution.complete-task" as const,
        request: {
          sessionId,
          taskId: "turn-0/root",
          actionIndex: 0,
          outcome: { status: "ok" as const, value: "done" },
          programCapability: opened.programCapability,
        },
      };
      yield* drivers.authority.command(complete);
      const before = yield* store.loadControl(executionId);
      // An idempotent replay returns without a new control revision or archive.
      yield* drivers.authority.command(complete);
      const after = yield* store.loadControl(executionId);
      expect(after?.controlRevision).toBe(before?.controlRevision);
    });
  });
});
