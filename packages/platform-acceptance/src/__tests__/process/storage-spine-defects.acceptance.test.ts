import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { sha256, sha256Bytes, type Json, canonicalJson } from "@sweatpants/foundation";
import { persistConversationCheckpoint } from "@sweatpants/durable-chat-runtime";
import type {
  ConversationHead,
  ConversationHeadProposal,
  HeadCommitResult,
  StoredPublicArchiveSegment,
  StoredTerminalSegment,
} from "@sweatpants/history-store/contract";
import { race, spawn, type Operation, run } from "effection";
import { installConversationStore } from "@sweatpants/history-store/port";
import {
  withTestScenario,
  type ScenarioContext,
  type ScriptConversation,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import {
  ACCEPTANCE_IMMEDIATE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  createAcceptanceApplication,
} from "../../lib/acceptance-app.ts";
import {
  openBetterSqliteStorage,
  type BetterSqliteStorageHandle,
} from "@sweatpants/storage-sqlite/better-sqlite3";

// Regression probes for the approved durability contract. These scenarios
// use the real application and storage composition; corruption is injected
// only at the explicitly marked fault boundaries.
const directories: string[] = [];

interface PublicSegmentRow {
  readonly segment_id: string;
  readonly conversation_id: string;
  readonly previous_segment_id: string | null;
  readonly min_position: number | bigint | string;
  readonly max_position: number | bigint | string;
  readonly roots_json: string;
  readonly content_hash: string;
  readonly encoded_bytes: number | bigint;
  readonly created_at: number | bigint;
}

interface TerminalSegmentRow {
  readonly segment_id: string;
  readonly conversation_id: string;
  readonly logical_turn_id: string;
  readonly execution_id: string;
  readonly publication_key: string;
  readonly previous_segment_id: string | null;
  readonly first_position: number | bigint | string;
  readonly last_position: number | bigint | string;
  readonly entries_json: string;
  readonly content_hash: string;
  readonly created_at: number | bigint;
}

function decimal(value: number | bigint | string): string {
  return BigInt(value).toString(10);
}

function temporaryDatabase(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sweatpants-storage-spine-defects-")).then((directory) => {
    directories.push(directory);
    return join(directory, "spine.sqlite");
  });
}

function idleProposal(head: ConversationHead): ConversationHeadProposal {
  return {
    state: "idle",
    checkpoint: head.checkpoint,
    terminalHistory: head.terminalHistory,
    activeLogicalTurnId: null,
    activeExecutionId: null,
    latestCompletedExecutionId: head.latestCompletedExecutionId,
    activeSegment: null,
    activeCommand: null,
    deletedAt: null,
    ownerTransition: { kind: "clear" },
  };
}

function persistentApplication(
  handle: BetterSqliteStorageHandle,
  storageProfile: "low" | "default" = "low",
): NonNullable<TestRigOptions["createApplication"]> {
  return (context) =>
    createAcceptanceApplication(context, undefined, {
      conversationStore: handle.storage.conversationStore,
      executionStore: handle.storage.executionStore,
      storageProfile,
    });
}

async function withPersistentScenario<T>(
  script: (scenario: ScenarioContext, handle: BetterSqliteStorageHandle) => Operation<T>,
  storageProfile: "low" | "default" = "low",
): Promise<T> {
  const databasePath = await temporaryDatabase();
  const handle = await run(() =>
    openBetterSqliteStorage(databasePath, { initialize: true, wal: false }),
  );
  try {
    return await withTestScenario(
      {
        binding: "in-process",
        modelId: ACCEPTANCE_MODEL_ID,
        scenarioTimeoutMs: 30_000,
        createApplication: persistentApplication(handle, storageProfile),
      },
      function* (scenario) {
        return yield* script(scenario, handle);
      },
    );
  } finally {
    await run(() => handle.close());
  }
}

function* completeImmediateTurn(
  scenario: ScenarioContext,
  conversation: ScriptConversation,
  index: number,
): Operation<void> {
  const turn = yield* conversation.send(
    `SPINE_DEFECT_TURN_${index} use the immediate fixture tool.`,
  );
  const initial = yield* scenario.model.request({ model: ACCEPTANCE_MODEL_ID });
  yield* initial.respond.toolCalls([
    {
      id: `spine-defect-call-${index}`,
      name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
      arguments: { value: `defect-value-${index}`, behavior: "complete" },
    },
  ]);
  const final = yield* race([
    scenario.model.request({ model: ACCEPTANCE_MODEL_ID }),
    (function* () {
      const failure = yield* turn.failure();
      throw new Error(`stored turn failed before final sampling: ${failure.message}`);
    })(),
  ]);
  yield* final.respond.text(`SPINE_DEFECT_RESULT_${index}`);
  expect((yield* turn.settled()).text).toContain(`SPINE_DEFECT_RESULT_${index}`);
}

function publicOrphanAfter(row: PublicSegmentRow): StoredPublicArchiveSegment {
  const position = BigInt(row.max_position) + 1n;
  const roots: readonly Json[] = [
    {
      rootId: "orphan-public-root",
      position: position.toString(10),
      kind: "message",
      state: "sealed",
      attribution: {},
      message: { id: "orphan-public", role: "user", content: "not-authoritative" },
      placement: { type: "root", sequence: Number(position) },
    },
  ];
  const encoded = canonicalJson(roots);
  return {
    segmentId: "orphan-public-segment",
    conversationId: row.conversation_id,
    previous: { segmentId: row.segment_id },
    minPosition: position.toString(10),
    maxPosition: position.toString(10),
    roots,
    contentHash: sha256(encoded),
    encodedBytes: new TextEncoder().encode(encoded).byteLength,
    createdAt: Number(row.created_at) + 1,
  };
}

function terminalOrphanAfter(row: TerminalSegmentRow): StoredTerminalSegment {
  const entries: readonly Json[] = [{ kind: "orphan-terminal-entry", marker: "not-authoritative" }];
  const encoded = canonicalJson(entries);
  const firstPosition = BigInt(row.last_position) + 1n;
  return {
    segmentId: "orphan-terminal-segment",
    conversationId: row.conversation_id,
    logicalTurnId: "orphan-logical-turn",
    executionId: "orphan-execution",
    publicationKey: "orphan-terminal-publication",
    previous: {
      segmentId: row.segment_id,
      lastPosition: decimal(row.last_position),
    },
    firstPosition: firstPosition.toString(10),
    lastPosition: firstPosition.toString(10),
    entries,
    contentHash: sha256(encoded),
    createdAt: Number(row.created_at) + 1,
  };
}

describe("database-backed durability-spine regression probes", () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("serializes concurrent writes on one application-owned SQLite connection", async () => {
    await withPersistentScenario(function* (scenario, handle) {
      const conversation = scenario.conversation({ conversationId: "defect-concurrent-writes" });
      yield* completeImmediateTurn(scenario, conversation, 0);

      const store = handle.storage.conversationStore;
      const current = yield* store.loadHead(conversation.conversationId);
      if (!current) {
        throw new Error("missing head after real test-rig turn");
      }
      const proposal = idleProposal(current);

      type Attempt =
        | { readonly status: "ok"; readonly value: HeadCommitResult }
        | { readonly status: "error"; readonly error: unknown };

      // These operations must overlap: the real adapter owns one physical
      // better-sqlite3 connection and must serialize its BEGIN IMMEDIATE calls.
      const left = yield* spawn(() =>
        (function* (): Operation<Attempt> {
          try {
            return {
              status: "ok",
              value: yield* store.compareAndSwapHead(
                conversation.conversationId,
                current.revision,
                current.ownerEpoch,
                proposal,
              ),
            };
          } catch (error) {
            return { status: "error", error };
          }
        })(),
      );
      const right = yield* spawn(() =>
        (function* (): Operation<Attempt> {
          try {
            return {
              status: "ok",
              value: yield* store.compareAndSwapHead(
                conversation.conversationId,
                current.revision,
                current.ownerEpoch,
                proposal,
              ),
            };
          } catch (error) {
            return { status: "error", error };
          }
        })(),
      );
      const outcomes = [yield* left, yield* right];
      expect(outcomes.every((outcome) => outcome.status === "ok")).toBe(true);
      expect(
        outcomes.filter(
          (outcome) => outcome.status === "ok" && outcome.value.status === "committed",
        ),
      ).toHaveLength(1);
      expect(
        outcomes.filter(
          (outcome) => outcome.status === "ok" && outcome.value.status === "head_conflict",
        ),
      ).toHaveLength(1);
    });
  }, 30_000);

  it("reads only the authoritative public archive chain, not an orphan row", async () => {
    await withPersistentScenario(function* (scenario, handle) {
      const conversation = scenario.conversation({ conversationId: "defect-public-chain" });
      yield* completeImmediateTurn(scenario, conversation, 0);
      yield* completeImmediateTurn(scenario, conversation, 1);
      yield* completeImmediateTurn(scenario, conversation, 2);

      const store = handle.storage.conversationStore;
      const head = yield* store.loadHead(conversation.conversationId);
      const checkpoint = head?.checkpoint ? yield* store.getCheckpoint(head.checkpoint) : null;
      if (!checkpoint) throw new Error("missing selected checkpoint");
      const basis = {
        lineageId: checkpoint.lineageId,
        basisRevision: head!.revision,
        archiveFrontierOrdinal: checkpoint.archiveFrontierOrdinal,
        nextPublicPosition: checkpoint.nextPublicPosition,
        hotRootPositions: [],
      };
      const before = yield* store.readPublicHistoryBefore({
        conversationId: conversation.conversationId,
        basis,
        beforePosition: checkpoint.nextPublicPosition,
        maxRoots: 256,
        maxBytes: 8 * 1024 * 1024,
      });
      const rows = handle.database.all(
        sql`SELECT segment_id, conversation_id, previous_segment_id,
                   min_position, max_position, roots_json, content_hash,
                   encoded_bytes, created_at
            FROM sp_conversation_public_segments
            WHERE conversation_id = ${conversation.conversationId}
            ORDER BY created_at DESC
            LIMIT 1`,
      ) as PublicSegmentRow[];
      const latest = rows[0];
      if (!latest) {
        throw new Error("real test-rig turn did not create a public archive segment");
      }

      // This is intentional orphan fault injection: it simulates immutable
      // publication succeeding before the subsequent head CAS loses a race.
      yield* store.putPublicArchiveSegment(publicOrphanAfter(latest));
      const after = yield* store.readPublicHistoryBefore({
        conversationId: conversation.conversationId,
        basis,
        beforePosition: checkpoint.nextPublicPosition,
        maxRoots: 256,
        maxBytes: 8 * 1024 * 1024,
      });
      expect(after.roots).toEqual(before.roots);
    });
  }, 30_000);

  it("reads only the authoritative terminal-history chain, not an orphan row", async () => {
    await withPersistentScenario(function* (scenario, handle) {
      const conversation = scenario.conversation({ conversationId: "defect-terminal-chain" });
      yield* completeImmediateTurn(scenario, conversation, 0);
      yield* completeImmediateTurn(scenario, conversation, 1);
      yield* completeImmediateTurn(scenario, conversation, 2);

      const store = handle.storage.conversationStore;
      const before = yield* store.readTerminalHistoryPage(
        conversation.conversationId,
        undefined,
        10_000,
      );
      const rows = handle.database.all(
        sql`SELECT segment_id, conversation_id, logical_turn_id, execution_id,
                   publication_key, previous_segment_id, first_position, last_position,
                   entries_json, content_hash, created_at
            FROM sp_conversation_terminal_segments
            WHERE conversation_id = ${conversation.conversationId}
            ORDER BY last_position DESC
            LIMIT 1`,
      ) as TerminalSegmentRow[];
      const latest = rows[0];
      if (!latest) {
        throw new Error("real test-rig turn did not create terminal history");
      }

      // Intentional pre-CAS orphan injection, as above.
      yield* store.putTerminalHistorySegment(terminalOrphanAfter(latest));
      const after = yield* store.readTerminalHistoryPage(
        conversation.conversationId,
        undefined,
        10_000,
      );
      expect(after.entries).toEqual(before.entries);
    });
  }, 30_000);

  it("does not let a stale terminal publication clear a live execution", async () => {
    await withPersistentScenario(function* (scenario, handle) {
      const conversation = scenario.conversation({ conversationId: "defect-stale-publication" });
      const turn = yield* conversation.send("STALE_PUBLICATION_V1");
      const pending = yield* scenario.model.request({ model: ACCEPTANCE_MODEL_ID });
      const store = handle.storage.conversationStore;
      const before = yield* store.loadHead(conversation.conversationId);
      if (!before?.activeExecutionId) {
        throw new Error("test-rig turn did not become active");
      }

      const request: Parameters<typeof persistConversationCheckpoint>[0] = {
        conversationId: conversation.conversationId,
        causeKey: "stale-terminal-publication",
        cause: {
          kind: "terminal",
          executionId: "not-the-active-execution",
        },
        roots: [{ type: "STALE_PUBLICATION_ROOT" }],
        expectedExecutionId: "not-the-active-execution",
        proposal: {
          state: "idle",
          terminalHistory: before.terminalHistory,
          activeLogicalTurnId: null,
          activeExecutionId: null,
          latestCompletedExecutionId: "not-the-active-execution",
          activeSegment: null,
          activeCommand: null,
          deletedAt: null,
          ownerTransition: { kind: "clear" },
        },
        createdAt: Date.now(),
      };
      let publicationError: unknown;
      try {
        yield* installConversationStore(store);
        yield* persistConversationCheckpoint(request);
      } catch (error) {
        publicationError = error;
      }

      expect(publicationError).toBeDefined();
      const after = yield* store.loadHead(conversation.conversationId);
      expect(after?.activeExecutionId).toBe(before.activeExecutionId);

      // Finish the real request after the ownership assertion so teardown
      // observes a settled Turn.
      yield* pending.respond.text("STALE_PUBLICATION_LIVE_RESULT");
      yield* turn.settled();
    });
  }, 30_000);

  it("does not spill hot roots when no sealed root is eligible", async () => {
    await withPersistentScenario(function* (scenario, handle) {
      const conversation = scenario.conversation({ conversationId: "defect-mutable-spill" });
      const turn = yield* conversation.send("MUTABLE_SPILL_V1");
      const pending = yield* scenario.model.request({ model: ACCEPTANCE_MODEL_ID });
      const store = handle.storage.conversationStore;
      const current = yield* store.loadHead(conversation.conversationId);
      if (!current?.checkpoint || !current.activeExecutionId) {
        throw new Error("test-rig did not publish a running checkpoint");
      }
      const beforeRows = handle.database.all(
        sql`SELECT COUNT(*) AS rows
            FROM sp_conversation_public_segments
            WHERE conversation_id = ${conversation.conversationId}`,
      ) as Array<{ rows: number | bigint }>;
      const beforeCount = Number(beforeRows[0]?.rows ?? 0);

      yield* installConversationStore(store);
      yield* persistConversationCheckpoint({
        conversationId: conversation.conversationId,
        causeKey: "mutable-only-rolling-cut",
        cause: { kind: "rolling", executionId: current.activeExecutionId },
        roots: [],
        proposal: {
          state: current.state,
          terminalHistory: current.terminalHistory,
          activeLogicalTurnId: current.activeLogicalTurnId,
          activeExecutionId: current.activeExecutionId,
          latestCompletedExecutionId: current.latestCompletedExecutionId,
          activeSegment: current.activeSegment,
          activeCommand: current.activeCommand,
          deletedAt: current.deletedAt,
          ownerTransition: { kind: "preserve" },
        },
        createdAt: Date.now(),
        expectedRevision: current.revision,
        expectedOwnerEpoch: current.ownerEpoch,
        expectedExecutionId: current.activeExecutionId,
        targets: {
          spill: { maxRoots: 1, maxEncodedBytes: 1024 * 1024 },
          segment: { maxEntries: 4, maxEncodedBytes: 1024 * 1024 },
        },
      });

      const afterRows = handle.database.all(
        sql`SELECT COUNT(*) AS rows
            FROM sp_conversation_public_segments
            WHERE conversation_id = ${conversation.conversationId}`,
      ) as Array<{ rows: number | bigint }>;
      expect(Number(afterRows[0]?.rows ?? 0)).toBe(beforeCount);

      yield* pending.respond.text("MUTABLE_SPILL_RESULT");
      yield* turn.settled();
    });
  }, 30_000);

  it("keeps complete semantic journal history out of mutable authority state", async () => {
    await withPersistentScenario(function* (scenario, handle) {
      const conversation = scenario.conversation({ conversationId: "defect-growing-snapshot" });
      yield* completeImmediateTurn(scenario, conversation, 0);
      yield* completeImmediateTurn(scenario, conversation, 1);
      yield* completeImmediateTurn(scenario, conversation, 2);

      const controls = handle.database.all(
        sql`SELECT control_json
            FROM sp_execution_control
            WHERE json_extract(control_json, '$.kind') = 'authority-control'`,
      ) as Array<{ control_json: string }>;
      expect(controls).toHaveLength(1);
      const control = JSON.parse(controls[0]!.control_json) as { snapshot?: { id?: string } };
      const snapshotId = control.snapshot?.id;
      expect(snapshotId).toEqual(expect.any(String));
      const snapshots = handle.database.all(
        sql`SELECT json_body
            FROM sp_execution_objects
            WHERE object_id = ${snapshotId}`,
      ) as Array<{ json_body: string | null }>;
      const snapshot = JSON.parse(snapshots[0]?.json_body ?? "null") as Record<string, unknown>;

      expect(snapshot).toHaveProperty("records", []);
    });
  }, 30_000);

  it("rejects an execution BLOB whose hash does not match its exact bytes", async () => {
    await withPersistentScenario(function* (scenario, handle) {
      const conversation = scenario.conversation({ conversationId: "defect-blob-integrity" });
      yield* completeImmediateTurn(scenario, conversation, 0);

      const body = new Uint8Array([0, 255, 1, 128]);
      const wrongBody = new Uint8Array([0, 255, 1, 129]);
      let error: unknown;
      try {
        yield* handle.storage.executionStore.putObject({
          objectId: "tampered-blob",
          lifetimeScope: "execution",
          scopeOwnerId: "defect-blob-integrity",
          objectKind: "fixture-artifact",
          contentHash: sha256Bytes(wrongBody),
          byteLength: body.byteLength,
          body,
          createdAt: Date.now(),
        });
      } catch (cause) {
        error = cause;
      }

      expect(error).toMatchObject({ code: "persisted_data_invalid" });
    });
  }, 30_000);
});
