import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalJson, canonicalSnapshot, sha256 } from "@sweatpants/foundation";
import { checkpointHotRoots } from "@sweatpants/history-store";
import { ConversationStoreApi, installConversationStore } from "@sweatpants/history-store/port";
import { ExecutionStoreApi, installExecutionStore } from "@sweatpants/journal-authority/api";
import { sql } from "drizzle-orm";
import { call, run, type Operation } from "effection";
import {
  withTestScenario,
  type ScenarioContext,
  type TestApplication,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import { createAcceptanceApplication } from "./lib/acceptance-app.ts";
import { ACCEPTANCE_MODEL_ID, ACCEPTANCE_IMMEDIATE_TOOL_NAME } from "./lib/acceptance-app.ts";
import {
  openBetterSqliteStorage,
  type BetterSqliteStorageHandle,
} from "@sweatpants/storage-sqlite/better-sqlite3";
import { readStorageReport, type StorageReport } from "@sweatpants/storage-sqlite/inspection";
import { installStorageReadMetrics } from "@sweatpants/storage-sqlite/metrics";
import type { ConversationHead, StoredCheckpoint } from "@sweatpants/history-store/contract";

const defaultDirectory = resolve(process.cwd(), ".tmp/storage-spine");
const defaultDatabase = resolve(defaultDirectory, "spine.sqlite");
const defaultExpected = resolve(defaultDirectory, "expected.json");
const conversationId = "storage-spine-conversation";
const profile = process.env["SPINE_PROFILE"] === "default" ? "default" : "low";
const turnCount = Number(process.env["SPINE_TURN_COUNT"] ?? (profile === "default" ? "20" : "10"));

interface FixtureExpected {
  readonly producerPid: number;
  readonly verifierProfile: "low" | "default";
  readonly conversationId: string;
  readonly head: ConversationHead;
  readonly publicRoots: readonly unknown[];
  readonly terminalEntries: readonly unknown[];
  readonly report: StorageReport;
  readonly privateEvidence: {
    readonly controls: number;
    readonly journalSegments: number;
    readonly replaySegments: number;
  };
}

function* readAllPublicRoots(
  head: ConversationHead,
  checkpoint: StoredCheckpoint,
): Operation<{
  readonly roots: readonly unknown[];
  readonly pages: number;
}> {
  const roots: unknown[] = [];
  let pages = 0;
  let beforePosition = checkpoint.nextPublicPosition;
  while (true) {
    const page = yield* ConversationStoreApi.operations.readPublicHistoryBefore({
      conversationId,
      basis: {
        lineageId: checkpoint.lineageId,
        basisRevision: head.revision,
        archiveFrontierOrdinal: checkpoint.archiveFrontierOrdinal,
        nextPublicPosition: checkpoint.nextPublicPosition,
        hotRootPositions: checkpointHotRoots(checkpoint.payload).map(
          (root) => (root as { position: string }).position,
        ),
      },
      beforePosition,
      maxRoots: 50,
      maxBytes: 1024 * 1024,
    });
    pages += 1;
    roots.unshift(...page.roots);
    if (page.nextBeforePosition === null) {
      roots.push(...checkpointHotRoots(checkpoint.payload));
      return { roots, pages };
    }
    beforePosition = page.nextBeforePosition;
  }
}

function* readAllTerminalEntries(): Operation<readonly unknown[]> {
  const entries: unknown[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = yield* ConversationStoreApi.operations.readTerminalHistoryPage(
      conversationId,
      cursor,
      50,
    );
    entries.push(...page.entries);
    if (page.nextCursor === null) return entries;
    cursor = page.nextCursor;
  }
}

function verifyPrivateSegments(
  handle: BetterSqliteStorageHandle,
): FixtureExpected["privateEvidence"] {
  const verify = (table: "sp_execution_journal_segments" | "sp_execution_replay_segments") => {
    const rows = handle.database.all(
      sql.raw(
        `SELECT segment_id, execution_id, task_id, previous_segment_id,
                first_sequence, last_sequence, entries_json, content_hash, encoded_bytes
         FROM ${table} ORDER BY execution_id, task_id, first_sequence`,
      ),
    ) as Array<{
      segment_id: string;
      execution_id: string;
      task_id: string;
      previous_segment_id: string | null;
      first_sequence: string;
      last_sequence: string;
      entries_json: string;
      content_hash: string;
      encoded_bytes: number | bigint;
    }>;
    const prior = new Map<string, { segmentId: string; lastSequence: bigint }>();
    for (const row of rows) {
      const entries = JSON.parse(row.entries_json) as unknown;
      if (!Array.isArray(entries)) throw new Error(`${table} ${row.segment_id} is not an array`);
      const encoded = canonicalSnapshot(entries);
      if (sha256(encoded.canonical) !== row.content_hash) {
        throw new Error(`${table} ${row.segment_id} has an invalid content hash`);
      }
      if (new TextEncoder().encode(encoded.canonical).byteLength !== Number(row.encoded_bytes)) {
        throw new Error(`${table} ${row.segment_id} has an invalid encoded byte count`);
      }
      const key = JSON.stringify([row.execution_id, row.task_id]);
      const previous = prior.get(key);
      const first = BigInt(row.first_sequence);
      const last = BigInt(row.last_sequence);
      if (last < first || last - first + 1n !== BigInt(entries.length)) {
        throw new Error(`${table} ${row.segment_id} has an invalid sequence range`);
      }
      if (previous) {
        if (
          row.previous_segment_id !== previous.segmentId ||
          first !== previous.lastSequence + 1n
        ) {
          throw new Error(`${table} ${row.segment_id} breaks its task-local chain`);
        }
      } else if (row.previous_segment_id !== null) {
        throw new Error(`${table} ${row.segment_id} has an unexpected predecessor`);
      }
      prior.set(key, { segmentId: row.segment_id, lastSequence: last });
    }
    return rows.length;
  };
  const controls = handle.database.all(
    sql`SELECT control_json FROM sp_execution_control`,
  ) as Array<{ control_json: string }>;
  for (const row of controls) {
    const control = JSON.parse(row.control_json) as Record<string, unknown>;
    if ("entries" in control || "journal" in control || "replay" in control) {
      throw new Error("execution control contains an embedded private history body");
    }
  }
  return {
    controls: controls.length,
    journalSegments: verify("sp_execution_journal_segments"),
    replaySegments: verify("sp_execution_replay_segments"),
  };
}

function* streamPrivateEvidence(
  handle: BetterSqliteStorageHandle,
): Operation<{ journalEntries: number; replayEntries: number }> {
  const controls = handle.database.all(
    sql`SELECT execution_id, control_json FROM sp_execution_control`,
  ) as Array<{ execution_id: string; control_json: string }>;
  let journalEntries = 0;
  let replayEntries = 0;
  for (const row of controls) {
    const control = JSON.parse(row.control_json) as Record<string, unknown>;
    if (control["kind"] !== "authority-control") continue;
    const journalHead = control["journalHead"] as {
      segmentId?: string;
      lastSequence?: string;
    } | null;
    const replayHead = control["replayHead"] as {
      segmentId?: string;
      lastSequence?: string;
    } | null;
    if (journalHead?.segmentId) {
      const stream = yield* ExecutionStoreApi.operations.readJournal({
        executionId: row.execution_id,
        taskId: "authority",
        head: journalHead as { segmentId: string; lastSequence: string },
      });
      journalEntries += yield* call(async () => {
        let count = 0;
        for await (const chunk of stream) count += chunk.length;
        return count;
      });
    }
    if (replayHead?.segmentId) {
      const stream = yield* ExecutionStoreApi.operations.readReplay({
        executionId: row.execution_id,
        taskId: "authority-archive",
        head: replayHead as { segmentId: string; lastSequence: string },
      });
      replayEntries += yield* call(async () => {
        let count = 0;
        for await (const chunk of stream) count += chunk.length;
        return count;
      });
    }
  }
  return { journalEntries, replayEntries };
}

function* readPreparedContextEvidence(handle: BetterSqliteStorageHandle): Operation<number> {
  const rows = handle.database.all(
    sql`SELECT object_id FROM sp_execution_objects
        WHERE object_kind = 'prepared-model-context.v1' ORDER BY object_id`,
  ) as Array<{ object_id: string }>;
  for (const row of rows) {
    const object = yield* ExecutionStoreApi.operations.getObject({ objectId: row.object_id });
    if (!object || object.objectKind !== "prepared-model-context.v1") {
      throw new Error("prepared model context evidence is missing or has the wrong kind");
    }
  }
  return rows.length;
}

function* collectExpected(
  handle: BetterSqliteStorageHandle,
  producerPid: number,
): Operation<FixtureExpected> {
  const metrics = yield* installStorageReadMetrics();
  yield* installConversationStore(handle.storage.conversationStore);
  yield* installExecutionStore(handle.storage.executionStore);
  metrics.reset();
  const head = yield* ConversationStoreApi.operations.loadHead(conversationId);
  if (!head) throw new Error("storage spine producer did not leave a conversation head");
  const checkpoint = head.checkpoint
    ? yield* ConversationStoreApi.operations.getCheckpoint(head.checkpoint)
    : null;
  if (head.checkpoint && !checkpoint) {
    throw new Error("storage spine head points to a missing checkpoint");
  }
  const publicPage = checkpoint
    ? yield* readAllPublicRoots(head, checkpoint)
    : { roots: [], pages: 0 };
  const terminalEntries = yield* readAllTerminalEntries();
  const streamed = yield* streamPrivateEvidence(handle);
  if (streamed.journalEntries === 0 || streamed.replayEntries === 0) {
    throw new Error("storage spine verifier did not stream private journal and replay evidence");
  }
  if ((yield* readPreparedContextEvidence(handle)) === 0) {
    throw new Error("storage spine verifier found no prepared model context objects");
  }
  const physical = readStorageReport(handle.database, metrics.metrics());
  if (
    physical.totalRetainedReplayBytes > 0 &&
    physical.peakMaterializedReplayBytes >= physical.totalRetainedReplayBytes
  ) {
    throw new Error("storage spine replay read was not bounded below retained replay bytes");
  }
  return {
    producerPid,
    verifierProfile: profile,
    conversationId,
    head,
    publicRoots: [
      ...publicPage.roots,
      ...(checkpoint ? checkpointHotRoots(checkpoint.payload) : []),
    ],
    terminalEntries,
    report: physical,
    privateEvidence: verifyPrivateSegments(handle),
  };
}

function* driveTurns(s: ScenarioContext): Operation<void> {
  const conversation = s.conversation({ conversationId });
  for (let index = 0; index < turnCount; index += 1) {
    const turn = yield* conversation.send(`SPINE_TURN_${index} use the immediate fixture tool.`);
    const initial = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
    yield* initial.respond.toolCalls([
      {
        id: `spine_call_${index}`,
        name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
        arguments: { value: `value-${index}`, behavior: "complete" },
      },
    ]);
    const final = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
    yield* final.respond.text(`SPINE_RESULT_${index}`);
    const transcript = yield* turn.settled();
    if (!transcript.text.includes(`SPINE_RESULT_${index}`)) {
      throw new Error(`Turn ${index} did not publish its expected terminal text`);
    }
  }
}

function createPersistentApplication(
  handle: BetterSqliteStorageHandle,
  storageProfile: "low" | "default",
): (context: Parameters<typeof createAcceptanceApplication>[0]) => TestApplication {
  return (context) =>
    createAcceptanceApplication(context, undefined, {
      conversationStore: handle.storage.conversationStore,
      executionStore: handle.storage.executionStore,
      storageProfile,
    });
}

async function produce(databasePath: string, expectedPath: string): Promise<void> {
  await mkdir(dirname(databasePath), { recursive: true });
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  const handle = await run(() =>
    openBetterSqliteStorage(databasePath, { migrate: true, wal: true }),
  );
  try {
    const createApplication = await createPersistentApplication(handle, profile);
    const options: TestRigOptions = {
      binding: "in-process",
      modelId: ACCEPTANCE_MODEL_ID,
      barrierTimeoutMs: profile === "default" ? 30_000 : 20_000,
      scenarioTimeoutMs: profile === "default" ? 150_000 : 90_000,
      createApplication,
    };
    await withTestScenario(options, driveTurns);
    const expected = await run(() => collectExpected(handle, process.pid));
    await writeFile(expectedPath, `${canonicalJson(expected)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ mode: "producer", databasePath, expectedPath })}\n`);
  } finally {
    await run(() => handle.close());
  }
}

async function verify(databasePath: string, expectedPath: string): Promise<void> {
  const expected = JSON.parse(await readFile(expectedPath, "utf8")) as FixtureExpected;
  if (expected.producerPid === process.pid) {
    throw new Error("storage spine verifier must run in a fresh process");
  }
  const handle = await run(() =>
    openBetterSqliteStorage(databasePath, { migrate: false, wal: true }),
  );
  try {
    const actual = await run(() => collectExpected(handle, expected.producerPid));
    const expectedComparable = { ...expected, producerPid: expected.producerPid };
    const actualComparable = { ...actual, producerPid: expected.producerPid };
    if (canonicalJson(actualComparable) !== canonicalJson(expectedComparable)) {
      throw new Error(
        `storage spine verification mismatch\nexpected=${canonicalJson(expectedComparable)}\nactual=${canonicalJson(actualComparable)}`,
      );
    }
    await writeFile(
      `${databasePath}.verified`,
      `${canonicalJson({ verifierPid: process.pid, producerPid: expected.producerPid, report: actual.report })}\n`,
      "utf8",
    );
    process.stdout.write(
      `${canonicalJson({ mode: "verifier", databasePath, report: actual.report })}\n`,
    );
  } finally {
    await run(() => handle.close());
  }
}

const [mode = "producer", databasePath = defaultDatabase, expectedPath = defaultExpected] =
  process.argv.slice(2);
if (mode === "producer") {
  await produce(resolve(databasePath), resolve(expectedPath));
} else if (mode === "verifier") {
  await verify(resolve(databasePath), resolve(expectedPath));
} else {
  throw new Error(`Unknown storage spine process mode ${mode}`);
}
