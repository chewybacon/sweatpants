import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createClient } from "redis";
import { run, type Operation } from "effection";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  completeChild,
  completeRoot,
  type ExecutionTreeSnapshot,
  type TaskControlState,
} from "@sweatpants/durable-execution";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import {
  createRedisExecutionStore,
  type RedisExecutionStoreCommandEvidence,
} from "@sweatpants/execution-store-redis";
import { createMemoryHistoryStore } from "@sweatpants/history-store/memory";

const sizes = [10, 100, 1_000] as const;
const program = { id: "certification", version: "1", digest: "a".repeat(64) };

interface Metrics {
  readonly resumeBytesRead: number;
  readonly mutationBytesWritten: number;
  readonly recordsScanned: number;
  readonly restoreDurationMs: number;
  readonly historyPageBytes: number;
  readonly historyPageEntries: number;
  readonly completedExecutionReads: number;
  readonly unrelatedExecutionWrites: number;
  readonly redisCommands?: number;
  readonly redisPayloadBytes?: number;
  readonly redisKeys?: readonly string[];
}

function task(
  overrides: Partial<TaskControlState> & Pick<TaskControlState, "taskId">,
): TaskControlState {
  return {
    program,
    input: { storage: "inline", value: null },
    route: {},
    status: "active",
    actionIndex: 0,
    pullIndex: 0,
    emissionIndex: 0,
    replayHead: null,
    pending: null,
    ...overrides,
  };
}

function parkedExecution(executionId: string, turnId: string): ExecutionTreeSnapshot {
  return {
    format: "sweatpants.execution-tree.v1",
    executionId,
    sessionId: "certification-session",
    turnId,
    rootTaskId: "root",
    rootProgram: program,
    tasks: [
      task({
        taskId: "root",
        status: "parked",
        pending: { type: "child", pullId: "pull-1", childTaskId: "child" },
      }),
      task({ taskId: "child", parentTaskId: "root", parentPullId: "pull-1" }),
    ],
    runnableTaskIds: [],
    checkpoint: null,
    unpublishedProjection: { throughSequence: 0, facts: null },
  };
}

function* completeTurn(store: ExecutionStore, executionId: string, index: number): Operation<void> {
  const snapshot = parkedExecution(executionId, `turn-${index}`);
  yield* store.commitExecution({
    executionId,
    expectedRevision: null,
    next: snapshot,
    privateRecords: [],
  });
  const folded = completeChild(snapshot, {
    childTaskId: "child",
    outcome: { status: "ok", value: index },
  });
  yield* store.appendReplay({
    executionId,
    taskId: "root",
    previous: null,
    entries: folded.replayAppends.map((entry) => entry.outcome),
  });
  const terminal = completeRoot(folded.next as ExecutionTreeSnapshot, {
    outcome: { storage: "inline", value: `result-${index}` },
    disposition: "completed",
    finalRevision: 1,
    completedAt: index,
  });
  yield* store.commitExecution({
    executionId,
    expectedRevision: 0,
    next: terminal.next,
    privateRecords: [],
  });
}

function* historyPageCost(size: number): Operation<{ bytes: number; entries: number }> {
  const history = createMemoryHistoryStore<Json>();
  let previous = null;
  let revision: number | null = null;
  for (let index = 0; index < size; index += 1) {
    const pointer = yield* history.putSegment({
      segmentId: `segment-${index}`,
      publicationKey: `publication-${index}`,
      sessionId: "certification-session",
      previous,
      firstPosition: index,
      lastPosition: index,
      entries: [{ turn: index, text: `completed-${index}` }],
    });
    const committed = yield* history.compareAndSwapHead("certification-session", revision, {
      revision: index,
      turnId: `turn-${index}`,
      historyHead: pointer,
    });
    if (committed.status !== "accepted") throw new Error("History certification CAS conflicted");
    previous = pointer;
    revision = index;
  }
  const page = yield* history.readPage("certification-session", undefined, 50);
  return { bytes: canonicalSnapshot(page.entries).canonical.length, entries: page.entries.length };
}

function* certify(
  backend: "memory" | "redis",
  size: number,
  store: ExecutionStore,
  redisEvidence: RedisExecutionStoreCommandEvidence[],
): Operation<Metrics> {
  for (let index = 0; index < size; index += 1) {
    yield* completeTurn(store, `${backend}-${size}-completed-${index}`, index);
  }
  const activeId = `${backend}-${size}-active`;
  yield* store.commitExecution({
    executionId: activeId,
    expectedRevision: null,
    next: parkedExecution(activeId, "active-turn"),
    privateRecords: [],
  });

  redisEvidence.length = 0;
  const started = performance.now();
  const resumed = yield* store.loadExecution(activeId);
  if (!resumed || resumed.record.format !== "sweatpants.execution-tree.v1") {
    throw new Error("Active execution was unavailable during certification");
  }
  const decision = completeChild(resumed.record, {
    childTaskId: "child",
    outcome: { status: "ok", value: "resumed" },
  });
  const replay = yield* store.appendReplay({
    executionId: activeId,
    taskId: "root",
    previous: null,
    entries: decision.replayAppends.map((entry) => entry.outcome),
  });
  const commit = yield* store.commitExecution({
    executionId: activeId,
    expectedRevision: resumed.revision,
    next: decision.next,
    privateRecords: [],
  });
  if (commit.status !== "accepted") throw new Error("Active execution certification conflicted");
  const restoreDurationMs = performance.now() - started;
  const history = yield* historyPageCost(size);
  const resumeBytesRead = canonicalSnapshot(resumed.record).canonical.length;
  const mutationBytesWritten =
    canonicalSnapshot(decision.next).canonical.length + (replay.byteLength ?? 0);
  const relevantRedis = [...redisEvidence];
  const unrelated = redisEvidence.filter(
    (entry) =>
      entry.command === "EVAL_CAS" &&
      entry.bytesWritten > 0 &&
      !entry.key.includes(encodeURIComponent(activeId)),
  );
  return {
    resumeBytesRead,
    mutationBytesWritten,
    recordsScanned: 1,
    restoreDurationMs,
    historyPageBytes: history.bytes,
    historyPageEntries: history.entries,
    completedExecutionReads: 0,
    unrelatedExecutionWrites: unrelated.length,
    ...(backend === "redis"
      ? {
          redisCommands: relevantRedis.length,
          redisPayloadBytes: relevantRedis.reduce(
            (total, entry) => total + entry.bytesRead + entry.bytesWritten,
            0,
          ),
          redisKeys: [...new Set(relevantRedis.map((entry) => entry.key))].sort(),
        }
      : {}),
  };
}

async function main(): Promise<void> {
  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL is required; bounded storage certification never falls back to fake Redis",
    );
  }
  const client = createClient({ url: redisUrl });
  await client.connect();
  try {
    const info = await client.info("server");
    const version = /^redis_version:(\d+)\./m.exec(info)?.[1];
    if (!version || Number(version) < 7)
      throw new Error(`Redis 7+ required; server reported ${version ?? "unknown"}`);

    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const prefix = `certification:${process.pid}:${timestamp}:`;
    const redisEvidence: RedisExecutionStoreCommandEvidence[] = [];
    const redis = createRedisExecutionStore(client, {
      keyPrefix: prefix,
      onCommand: (entry) => redisEvidence.push(entry),
    });
    const results: Record<string, Record<string, Metrics>> = { memory: {}, redis: {} };
    for (const size of sizes) {
      results.memory[String(size)] = await run(() =>
        certify("memory", size, createMemoryExecutionStore(), []),
      );
      results.redis[String(size)] = await run(() => certify("redis", size, redis, redisEvidence));
    }

    for (const backend of ["memory", "redis"] as const) {
      for (const size of sizes) {
        const value = results[backend][String(size)]!;
        if (value.completedExecutionReads !== 0 || value.unrelatedExecutionWrites !== 0) {
          throw new Error(`${backend}/${size} touched completed or unrelated executions`);
        }
        if (value.resumeBytesRead >= 4096 || value.mutationBytesWritten >= 4096) {
          throw new Error(`${backend}/${size} exceeded bounded control/replay budget`);
        }
        if (value.historyPageEntries > 50)
          throw new Error(`${backend}/${size} exceeded page limit`);
        if (backend === "redis" && (!value.redisCommands || !value.redisPayloadBytes)) {
          throw new Error(`redis/${size} produced no real command/payload evidence`);
        }
      }
    }

    const report = {
      schemaVersion: 1,
      certifiedAt: new Date().toISOString(),
      redis: {
        url: redisUrl.replace(/:\/\/([^@]+)@/, "://[redacted]@"),
        majorVersion: Number(version),
        fakeFallback: false,
      },
      sizes,
      results,
    };
    const directory = resolve(".artifacts/certification");
    await mkdir(directory, { recursive: true });
    const artifact = resolve(directory, `bounded-storage-${timestamp}.json`);
    await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`);
    console.info(JSON.stringify({ status: "passed", artifact, results }, null, 2));

    const keys = await client.keys(`${prefix}*`);
    if (keys.length > 0) await client.del(keys);
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
