/**
 * Storage kernel benchmark: Postgres vs SQLite, identical workloads at the
 * `DurableKernel` boundary (the seam every backend must implement).
 *
 * Usage:
 *   pnpm --filter @sweatpants/storage-postgres exec tsx scripts/bench.ts [N] [WORKERS]
 *
 * Requires the test Postgres container: run scripts/ensure-test-postgres.mjs
 * first (or run the package's vitest once). Record IDs are run-scoped, so
 * re-running is safe.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import {
  DurableCollections,
  DurableIndexes,
  durableKey,
  type DurableKernel,
} from "@sweatpants/durable-storage-kernel";
import {
  encodeArchivedPublicRootIndex,
  encodeCommandReceipt,
  encodeConversationHead,
  type CommandReceipt,
  type ConversationHead,
} from "@sweatpants/history-store/persistence";
import { openBetterSqliteStorageForTest } from "@sweatpants/storage-sqlite/testing";
import { openPostgresStorageForTest } from "../src/pg-binding.ts";

const N = Number(process.argv[2] ?? 1_000);
const WORKERS = Number(process.argv[3] ?? 8);
const WARMUP = 50;
const SCAN_TOTAL = 2_000;
const SCAN_PAGES = 200;
const PAGE_SIZE = SCAN_TOTAL / 20; // 20 pages of 100
/** The Docker harness always listens here; override via SWEATPANTS_DATABASE_URL. */
const connectionString =
  process.env.SWEATPANTS_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:55432/sweatpants_test";

// ---- workload value builders (kernel values must decode; these are the
// canonical encoded forms the repositories produce) ----

function headValue(conversationId: string, revision: number): Uint8Array {
  const head: ConversationHead = {
    conversationId,
    revision: String(revision),
    ownerEpoch: "0",
    ownerRoute: null,
    state: "idle",
    checkpoint: null,
    terminalHistory: null,
    activeLogicalTurnId: null,
    activeExecutionId: null,
    latestCompletedExecutionId: null,
    activeSegment: null,
    activeCommand: null,
    deletedAt: null,
    updatedAt: 1,
  };
  return encodeConversationHead(head);
}

function receipt(conversationId: string, commandId: string): { digest: string; value: Uint8Array } {
  const receipt: CommandReceipt = {
    conversationId,
    commandId,
    commandDigest: `digest-${commandId}`,
    participantId: "bench",
    acceptedAt: 1,
    retainUntil: 2,
    admittedRevision: "0",
    resultingRevision: "1",
  };
  return { digest: receipt.commandDigest, value: encodeCommandReceipt(receipt) };
}

function rootIndexValue(conversationId: string, position: number): Uint8Array {
  return encodeArchivedPublicRootIndex({
    conversationId,
    position: String(position),
    rootId: `root-${position}`,
    segmentId: `seg-${position}`,
    segmentRootIndex: 0,
    archiveOrdinal: String(position),
    contentHash: `hash-${position}`,
    encodedBytes: 10,
  });
}

// ---- measurement ----

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function measure(
  n: number,
  body: () => Promise<void>,
): Promise<{ samples: number[]; totalMs: number }> {
  const samples: number[] = [];
  const start = performance.now();
  for (let i = 0; i < n; i += 1) {
    const opStart = performance.now();
    await body();
    samples.push(performance.now() - opStart);
  }
  return { samples, totalMs: performance.now() - start };
}

interface Series {
  readonly opsPerSec: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

function summarize(samples: number[], totalMs: number, count = samples.length): Series {
  return {
    opsPerSec: Math.round((count / totalMs) * 1000),
    p50: +percentile(samples, 50).toFixed(3),
    p95: +percentile(samples, 95).toFixed(3),
    p99: +percentile(samples, 99).toFixed(3),
  };
}

async function benchBackend(
  name: string,
  open: () => Promise<{ kernel: DurableKernel; close: () => Promise<void> }>,
): Promise<void> {
  const handle = await open();
  const kernel = handle.kernel;
  const runId = `${Date.now()}`;
  const conversationId = `bench-conv-${runId}`;
  const headKey = durableKey(conversationId);

  // Create the head at revision 0.
  const created = await run(() =>
    kernel.apply({
      authority: {
        name: "bench-create",
        collection: DurableCollections.conversationHeads,
        key: headKey,
        expected: { revision: null, fence: null },
        next: { revision: "0", fence: "0", value: headValue(conversationId, 0) },
      },
      ensures: [],
    }),
  );
  if (created.status !== "committed") throw new Error(`setup failed: ${JSON.stringify(created)}`);

  // Warmup: claim + CAS chain.
  let revision = 0;
  for (let i = 0; i < WARMUP; i += 1) {
    const claim = receipt(conversationId, `warmup-${runId}-${i}`);
    const result = await run(() =>
      kernel.apply({
        claim: {
          name: `warmup-${i}`,
          collection: DurableCollections.conversationCommandReceipts,
          key: durableKey(conversationId, `warmup-${runId}-${i}`),
          fingerprint: claim.digest,
          value: claim.value,
        },
        authority: {
          name: "bench",
          collection: DurableCollections.conversationHeads,
          key: headKey,
          expected: { revision: String(revision) },
          next: { revision: String(revision + 1), value: headValue(conversationId, revision + 1) },
        },
        ensures: [],
      }),
    );
    if (result.status !== "committed") throw new Error("warmup failed");
    revision += 1;
  }

  // 1. CAS commit — claim (idempotent receipt) + head revision bump: the
  // command-commit hot path.
  const cas = await measure(N, async () => {
    const claim = receipt(conversationId, `cas-${runId}-${revision}`);
    const result = await run(() =>
      kernel.apply({
        claim: {
          name: "bench-claim",
          collection: DurableCollections.conversationCommandReceipts,
          key: durableKey(conversationId, `cas-${runId}-${revision}`),
          fingerprint: claim.digest,
          value: claim.value,
        },
        authority: {
          name: "bench",
          collection: DurableCollections.conversationHeads,
          key: headKey,
          expected: { revision: String(revision) },
          next: { revision: String(revision + 1), value: headValue(conversationId, revision + 1) },
        },
        ensures: [],
      }),
    );
    if (result.status !== "committed") throw new Error("cas commit failed");
    revision += 1;
  });

  // 2. Read head.
  const read = await measure(N, () =>
    run(() => kernel.readAuthority(DurableCollections.conversationHeads, headKey)),
  );

  // 3. Immutable append — ensure only, no authority.
  const append = await measure(N, async () => {
    const index = `append-${runId}-${revision}`;
    const r = receipt(conversationId, index);
    const result = await run(() =>
      kernel.apply({
        ensures: [
          {
            name: "bench-append",
            collection: DurableCollections.conversationCommandReceipts,
            key: durableKey(conversationId, index),
            fingerprint: r.digest,
            value: r.value,
          },
        ],
      }),
    );
    if (result.status !== "committed") throw new Error("append failed");
    revision += 1;
  });

  // 4. Scan — prepare 2,000 root-index entries, page through them 20 rows
  // at PAGE_SIZE.
  for (let i = 0; i < SCAN_TOTAL; i += 1) {
    const result = await run(() =>
      kernel.apply({
        ensures: [
          {
            name: `root-${i}`,
            collection: DurableCollections.conversationPublicRootIndex,
            key: durableKey(conversationId, String(i)),
            fingerprint: `hash-${i}`,
            value: rootIndexValue(conversationId, i),
          },
        ],
      }),
    );
    if (result.status !== "committed") throw new Error("scan prep failed");
  }
  const scan = await measure(SCAN_PAGES, () =>
    run(function* () {
      let after: string | null = null;
      let rows = 0;
      for (;;) {
        const page = yield* kernel.scan({
          collection: DurableCollections.conversationPublicRootIndex,
          index: DurableIndexes.conversationPosition,
          scope: durableKey(conversationId),
          direction: "forward",
          after,
          maxRecords: PAGE_SIZE,
          maxStoredBytes: 16 * 1024 * 1024,
        });
        rows += page.records.length;
        after = page.nextCursor;
        if (after === null) break;
      }
      if (rows !== SCAN_TOTAL) throw new Error(`expected ${SCAN_TOTAL} rows, saw ${rows}`);
    }),
  );

  // 5. Concurrent CAS — WORKERS workers read-modify-CAS the same head with
  // retry on conflict; measures contention behavior.
  let retries = 0;
  const commitsPerWorker = 50;
  const concurrentStart = performance.now();
  await Promise.all(
    Array.from({ length: WORKERS }, async (_, worker) => {
      let done = 0;
      while (done < commitsPerWorker) {
        const current = await run(() =>
          kernel.readAuthority(DurableCollections.conversationHeads, headKey),
        );
        if (!current) throw new Error("head vanished");
        const next = BigInt(current.revision) + 1n;
        const result = await run(() =>
          kernel.apply({
            authority: {
              name: `bench-worker-${worker}`,
              collection: DurableCollections.conversationHeads,
              key: headKey,
              expected: { revision: current.revision },
              next: { revision: next.toString(), value: headValue(conversationId, Number(next)) },
            },
            ensures: [],
          }),
        );
        if (result.status === "committed") {
          done += 1;
        } else {
          retries += 1;
        }
      }
    }),
  );
  const concurrentMs = performance.now() - concurrentStart;

  await handle.close();

  const fmt = (s: Series) => `${s.opsPerSec}/s  p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms`;
  console.log(`\nbackend: ${name}  (N=${N}, workers=${WORKERS})`);
  console.log(`  cas-commit (apply w/ claim+CAS)   ${fmt(summarize(cas.samples, cas.totalMs))}`);
  console.log(`  read-head                          ${fmt(summarize(read.samples, read.totalMs))}`);
  console.log(
    `  immutable-append (ensure only)     ${fmt(summarize(append.samples, append.totalMs))}`,
  );
  console.log(
    `  scan full pass (${SCAN_PAGES} pages)         ${fmt(summarize(scan.samples, scan.totalMs))}`,
  );
  console.log(
    `  concurrent cas (${WORKERS}w x ${commitsPerWorker})      ${Math.round(
      ((WORKERS * commitsPerWorker) / concurrentMs) * 1000,
    )} commits/s  retries=${retries}`,
  );
}

const sqliteDir = await mkdtemp(join(tmpdir(), "sweatpants-bench-sqlite-"));
try {
  await benchBackend("postgres", async () => {
    const handle = await openPostgresStorageForTest({ connectionString, migrate: true });
    return { kernel: handle.kernel, close: () => run(() => handle.close()) };
  });
  await benchBackend("postgres (sync_commit=off)", async () => {
    const handle = await openPostgresStorageForTest({
      connectionString,
      migrate: true,
      synchronousCommit: "off",
    });
    return { kernel: handle.kernel, close: () => run(() => handle.close()) };
  });
  await benchBackend("sqlite", async () => {
    const handle = await run(() =>
      openBetterSqliteStorageForTest(join(sqliteDir, "bench.sqlite"), { migrate: true, wal: true }),
    );
    return { kernel: handle.kernel, close: () => run(() => handle.close()) };
  });
} finally {
  await rm(sqliteDir, { recursive: true, force: true }).catch(() => undefined);
}
