// @vitest-environment node
import { run } from "effection";
import { createJournal } from "../../../packages/journal-authority/src/shell/journal.ts";
import { createCapabilityKeyring } from "../../../packages/journal-authority/src/contract/capabilities.ts";
import {
  openBetterSqliteStorage,
  BetterSqliteDatabase,
} from "@sweatpants/storage-sqlite/better-sqlite3";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { DurableSemanticRecord } from "../../../packages/journal-authority/src/contract/semantic-record.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = resolve(root, ".artifacts/journal-primitives");
mkdirSync(artifacts, { recursive: true });
const directory = mkdtempSync(join(artifacts, "recovery-process-"));
let invocation = 0;
async function launch(database: string, variant = "normal", engine = "candidate", stop = -1) {
  const index = invocation++;
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--conditions=development",
          "--import",
          "tsx",
          resolve(root, "acceptance/fixtures/journal-primitives/worker.ts"),
          engine,
          database,
          String(stop),
          variant,
        ],
        { cwd: root, env: { ...process.env, SEQUENCE_RECOVERY: "1" }, timeout: 20000 },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        done({ status, stdout, stderr });
      });
    },
  );
  writeFileSync(`${database}.${index}.${variant}.process.json`, JSON.stringify(result, null, 2));
  return result;
}
function lines(database: string, suffix: string): unknown[] {
  return existsSync(`${database}.${suffix}.jsonl`)
    ? readFileSync(`${database}.${suffix}.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown)
    : [];
}
async function inspect(database: string, label: string) {
  const child = await launch(database, "normal", "inspect");
  expect(child.status, child.stderr).toBe(0);
  const report = JSON.parse(readFileSync(`${database}.report.json`, "utf8")) as {
    records: DurableSemanticRecord[];
    state: { status: string };
    plan: {
      rows: Array<{ classification: string; parked?: { pullId: string } }>;
      replay: unknown[];
    };
  };
  writeFileSync(`${database}.${label}.json`, JSON.stringify(report, null, 2));
  copyFileSync(database, `${database}.${label}.sqlite`);
  return report;
}
// Negative readback needs an independent closed/reopened resource, not another
// interpreter startup. Positive interruption boundaries still use inspect above.
async function inspectRejected(database: string) {
  const records = await run(function* () {
    const handle = yield* openBetterSqliteStorage(database, { wal: false });
    try {
      const journal = yield* createJournal(handle.storage.executionStore, {
        journalId: "sequence-journal",
        journalIncarnation: "1",
        keyring: createCapabilityKeyring("fixture", [{ keyId: "fixture", secret: "x".repeat(32) }]),
      });
      return yield* journal.readSession("session");
    } finally {
      yield* handle.close();
    }
  });
  writeFileSync(`${database}.denied.json`, JSON.stringify({ records }, null, 2));
  copyFileSync(database, `${database}.denied.sqlite`);
  return { records };
}
function payloads(records: DurableSemanticRecord[], type: string) {
  return records.filter(({ payload }) => payload.type === type).map(({ payload }) => payload);
}
function databaseState(path: string) {
  const database = new BetterSqliteDatabase(path, { readonly: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return tables.map(({ name }) => ({
      name,
      rows: database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    }));
  } finally {
    database.close();
  }
}
function failure(database: string) {
  return JSON.parse(readFileSync(`${database}.error.json`, "utf8")) as {
    code: string | null;
    message: string;
  };
}
function clock(database: string, now: number) {
  // All processes read this persisted fixture clock. The actual authority compares lease expiry.
  writeFileSync(`${database}.clock.json`, String(now));
}
function delivered(database: string) {
  return lines(database, "guest").flatMap((line) => {
    const { event } = line as { event: { type: string; value?: string } };
    return event.type === "delivered" ? [event.value] : [];
  });
}

// Reuse only persisted setup for rejection cases. Every candidate and readback is
// still a fresh OS process against its own copied database and external ledger.
const pendingFixture = join(directory, "rejection-fixture.sqlite");
let pendingReport: Awaited<ReturnType<typeof inspect>>;
beforeAll(async () => {
  expect((await launch(pendingFixture, "normal", "candidate", 0)).status).toBe(73);
  expect((await launch(pendingFixture, "loss-before-acceptance")).status).toBe(74);
  pendingReport = await inspect(pendingFixture, "persisted-setup");
});
function copyPendingFixture(database: string) {
  for (const suffix of ["", ".calls.jsonl", ".guest.jsonl", ".capabilities.jsonl"]) {
    copyFileSync(`${pendingFixture}${suffix}`, `${database}${suffix}`);
  }
  clock(database, 31001);
  return pendingReport;
}

describe("explicit sequential recovery across OS process loss", () => {
  it("reexecutes the unresolved second occurrence only after expiry and delivers accepted readback", async () => {
    const database = join(directory, "external-completion.sqlite");
    expect((await launch(database, "normal", "candidate", 0)).status).toBe(73);
    const first = await inspect(database, "first-accepted");
    expect((await launch(database, "loss-before-acceptance")).status).toBe(74);
    const lost = await inspect(database, "external-completed-unaccepted");
    expect(lost.state.status).toBe("active");
    expect(lost.plan.rows[0]?.classification).toBe("structurally_blocked");
    expect(lost.plan.replay).toHaveLength(0);
    expect(payloads(lost.records, "PullResolved")).toEqual(payloads(first.records, "PullResolved"));
    expect(payloads(lost.records, "PullRequested")).toHaveLength(2);
    expect(
      lost.records.flatMap(({ payload }) =>
        payload.type === "PullRequested" ? [[payload.actionIndex, payload.pullIndex]] : [],
      ),
    ).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(lines(database, "calls")).toHaveLength(2);
    expect(delivered(database)).not.toContain("hello:recorded:2");
    const live = await launch(database);
    expect(live.status).toBe(1);
    expect(live.stderr).toContain("Recovery cannot replace a live owner");
    expect(lines(database, "calls")).toHaveLength(2);
    expect((await inspect(database, "live-denied")).records).toEqual(lost.records);
    clock(database, 31001);
    const resumed = await launch(database);
    expect(resumed.status, resumed.stderr).toBe(0);
    const result = JSON.parse(readFileSync(`${database}.report.json`, "utf8")) as {
      result: string;
    };
    expect(result.result).toBe("hello:recorded:1|hello:recorded:3:done");
    const completed = await inspect(database, "completed");
    expect(payloads(completed.records, "PullRequested")).toEqual(
      payloads(lost.records, "PullRequested"),
    );
    expect(payloads(completed.records, "PullResolved")[0]).toEqual(
      payloads(first.records, "PullResolved")[0],
    );
    const attempts = completed.records.flatMap(({ payload }) =>
      payload.type === "AttemptStarted" ? [payload] : [],
    );
    expect(attempts).toHaveLength(3);
    expect(attempts.map((attempt) => attempt.attemptIndex)).toEqual([0, 0, 1]);
    expect(attempts[2]?.pullId).toBe(attempts[1]?.pullId);
    expect(attempts[2]?.pullId).not.toBe(attempts[0]?.pullId);
    expect(attempts[2]?.attemptId).not.toBe(attempts[1]?.attemptId);
    expect(payloads(completed.records, "AttemptAbandoned")).toHaveLength(1);
    expect(delivered(database)).not.toContain("hello:recorded:2");
    expect(delivered(database)).toContain("hello:recorded:3");
    expect(lines(database, "calls")).toHaveLength(3);
    expect((await launch(database)).status).toBe(0);
    expect((await inspect(database, "terminal-repeat")).records).toEqual(completed.records);
    expect(lines(database, "calls")).toHaveLength(3);
  });

  it("survives loss after committed recovery permission before dispatch", async () => {
    const database = join(directory, "permission-loss.sqlite");
    expect((await launch(database, "loss-before-acceptance")).status).toBe(74);
    clock(database, 31001);
    expect((await launch(database, "loss-after-permission")).status).toBe(75);
    const permitted = await inspect(database, "permission-without-dispatch");
    expect(payloads(permitted.records, "AttemptStarted")).toHaveLength(2);
    expect(payloads(permitted.records, "PullRequested")).toHaveLength(1);
    expect(payloads(permitted.records, "PullResolved")).toHaveLength(0);
    expect(lines(database, "calls")).toHaveLength(1);
    expect(delivered(database)).toEqual([]);
    expect((await launch(database)).stderr).toContain("Recovery cannot replace a live owner");
    clock(database, 61002);
    const resumed = await launch(database);
    expect(resumed.status, resumed.stderr).toBe(0);
    const completed = await inspect(database, "completed");
    const attempts = completed.records.flatMap(({ payload }) =>
      payload.type === "AttemptStarted" ? [payload] : [],
    );
    expect(attempts).toHaveLength(4);
    expect(attempts.slice(0, 3).map((attempt) => attempt.pullId)).toEqual(
      Array(3).fill(attempts[0]?.pullId),
    );
    expect(payloads(completed.records, "PullRequested")).toHaveLength(2);
    expect(payloads(completed.records, "AttemptAbandoned")).toHaveLength(2);
    expect(lines(database, "calls")).toHaveLength(3);
    expect(delivered(database)).not.toContain("hello:recorded:1");
    expect(delivered(database)).toContain("hello:recorded:2");
  });

  it.each([
    ["truncated", null, "Experimental replay head mismatch"],
    ["digest-invalid", "replay_diverged", "Replay entry digest differs"],
    ["wrong-head", null, "Experimental program/input identity mismatch"],
    ["divergent", "replay_diverged", "Evaluator operation differs from history"],
    ["pending-divergent", null, "Experimental pending occurrence differs from guest frontier"],
    ["pending-completed", null, "Experimental pending occurrence differs from guest frontier"],
    ["changed-input", null, "Experimental program/input identity mismatch"],
    ["changed-program", null, "Experimental program/input identity mismatch"],
    ["extra-history", "replay_diverged", "Evaluator operation differs from history"],
    [
      "unsupported-driver",
      null,
      "Experimental journal supports only local program placement without affinity",
    ],
    [
      "affinity",
      null,
      "Experimental journal supports only local program placement without affinity",
    ],
  ] as const)(
    "rejects parked %s before recovery permission or dispatch",
    async (variant, code, message) => {
      const database = join(directory, `${variant}.sqlite`);
      const before = copyPendingFixture(database);
      const stored = databaseState(database);
      const traceStart = lines(database, "guest").length;
      const failed = await launch(database, variant);
      const attemptedCommands = JSON.stringify(lines(database, "guest").slice(traceStart));
      expect(attemptedCommands).not.toContain("execution.bind-attachment");
      expect(attemptedCommands).not.toContain("execution.recover-record");
      expect(failed.status, failed.stderr).toBe(1);
      expect(failure(database)).toEqual({ code, message });
      expect(databaseState(database)).toEqual(stored);
      expect((await inspectRejected(database)).records).toEqual(before.records);
      expect(lines(database, "calls")).toHaveLength(2);
      expect(delivered(database)).not.toContain("hello:recorded:2");
    },
  );

  it("denies persisted multiple-root topology before recovery or dispatch", async () => {
    const database = join(directory, "multiple-roots.sqlite");
    expect((await launch(database, "loss-before-acceptance")).status).toBe(74);
    expect((await launch(database, "seed-second-root")).status).toBe(0);
    clock(database, 31001);
    const before = await inspect(database, "before");
    const failed = await launch(database);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("requires one root strand");
    expect((await inspect(database, "denied")).records).toEqual(before.records);
    expect(lines(database, "calls")).toHaveLength(1);
    expect(delivered(database)).toEqual([]);
  });

  it("denies an actually persisted unsafe pending record without external dispatch", async () => {
    const database = join(directory, "stored-unsafe.sqlite");
    expect((await launch(database, "seed-unsafe")).status).toBe(0);
    const before = await inspect(database, "unsafe-pending");
    expect(payloads(before.records, "PullRequested")).toHaveLength(1);
    const failed = await launch(database);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("pending occurrence differs");
    expect((await inspect(database, "denied")).records).toEqual(before.records);
    expect(lines(database, "calls")).toEqual([]);
    expect(delivered(database)).toEqual([]);
    const stored = databaseState(database);
    for (const now of [31001, 61002]) {
      clock(database, now);
      const traceStart = lines(database, "guest").length;
      expect((await launch(database, "unsafe")).status).toBe(1);
      expect(failure(database)).toEqual({
        code: null,
        message: "Experimental journal supports only repeatable records",
      });
      expect(databaseState(database)).toEqual(stored);
      const commands = JSON.stringify(lines(database, "guest").slice(traceStart));
      expect(commands).not.toContain("execution.bind-attachment");
      expect(commands).not.toContain("execution.recover-record");
      expect(lines(database, "calls")).toEqual([]);
      expect(delivered(database)).toEqual([]);
    }
    expect((await inspect(database, "repeated-unsafe-denied")).records).toEqual(before.records);
  });

  it("releases a failed recovery handler mandate and can recover after legitimate release", async () => {
    const database = join(directory, "recovery-cleanup.sqlite");
    expect((await launch(database, "loss-before-acceptance")).status).toBe(74);
    clock(database, 31001);
    const failed = await launch(database, "handler-error");
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("fixture handler failure");
    const released = await inspect(database, "released");
    expect(payloads(released.records, "AttemptStarted")).toHaveLength(2);
    expect(payloads(released.records, "AdvancementReleased")).toHaveLength(1);
    expect(lines(database, "calls")).toHaveLength(1);
    const resumed = await launch(database);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(delivered(database)).not.toContain("hello:recorded:1");
  });
});

// A single ordered crash trajectory, split at durable boundaries to keep each
// phase inside the existing per-case budget. No synthetic interruption states.
describe.sequential("repeated loss at both identical occurrences", () => {
  const database = join(directory, "repeated.sqlite");
  let firstAccepted: DurableSemanticRecord[];
  it("loses two first-occurrence results with an interleaved permission loss", async () => {
    expect((await launch(database, "loss-before-acceptance")).status).toBe(74);
    clock(database, 31001);
    expect((await launch(database, "loss-after-permission")).status).toBe(75);
    clock(database, 61002);
    expect((await launch(database, "loss-before-acceptance")).status).toBe(74);
    const lost = await inspect(database, "first-lost-twice");
    expect(payloads(lost.records, "PullResolved")).toEqual([]);
    expect(lines(database, "calls")).toHaveLength(2);
    expect(delivered(database)).toEqual([]);
    expect((await launch(database, "probe-retained")).status).toBe(0);
    expect((await launch(database)).status).toBe(1);
    expect(failure(database)).toEqual({
      code: "stale_program_capability",
      message: "Recovery cannot replace a live owner",
    });
  });
  it("accepts only the third external result then rejects retained authority again", async () => {
    clock(database, 91003);
    expect((await launch(database, "normal", "candidate", 0)).status).toBe(73);
    const accepted = await inspect(database, "first-accepted");
    firstAccepted = accepted.records;
    expect(payloads(firstAccepted, "PullResolved")).toMatchObject([
      { outcome: { status: "ok", value: "hello:recorded:3" } },
    ]);
    expect((await launch(database, "probe-retained")).status).toBe(0);
    expect(lines(database, "calls")).toHaveLength(3);
    expect(delivered(database)).toEqual([]);
  });
  it("loses two second-occurrence results without redispatching the accepted first", async () => {
    expect((await launch(database, "loss-before-acceptance")).status).toBe(74);
    clock(database, 121004);
    expect((await launch(database, "loss-before-acceptance")).status).toBe(74);
    const lost = await inspect(database, "second-lost-twice");
    expect(payloads(lost.records, "PullResolved")).toEqual(payloads(firstAccepted, "PullResolved"));
    expect(lines(database, "calls")).toHaveLength(5);
    expect(new Set(delivered(database))).toEqual(new Set(["hello:recorded:3"]));
    expect((await launch(database, "probe-retained-second")).status).toBe(0);
    expect((await launch(database, "probe-retained")).status).toBe(0);
  });
  it("completes with exact lineage, call order and accepted outcomes", async () => {
    clock(database, 151005);
    expect((await launch(database)).status).toBe(0);
    expect(JSON.parse(readFileSync(`${database}.report.json`, "utf8"))).toMatchObject({
      result: "hello:recorded:3|hello:recorded:6:done",
    });
    const completed = await inspect(database, "completed");
    const requested = completed.records.flatMap(({ payload }) =>
      payload.type === "PullRequested" ? [payload] : [],
    );
    expect(requested.map(({ actionIndex, pullIndex }) => [actionIndex, pullIndex])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(requested[0]!.pullId).not.toBe(requested[1]!.pullId);
    const attempts = completed.records.flatMap(({ payload }) =>
      payload.type === "AttemptStarted" ? [payload] : [],
    );
    expect(
      attempts.map(({ pullId, attemptIndex, attemptId }) => [pullId, attemptIndex, attemptId]),
    ).toEqual(
      [
        [0, 0],
        [0, 1],
        [0, 2],
        [0, 3],
        [1, 0],
        [1, 1],
        [1, 2],
      ].map(([occurrence, index]) => {
        const pullId = requested[occurrence!]!.pullId;
        return [pullId, index, `${pullId}:attempt-${index}`];
      }),
    );
    const abandoned = completed.records.flatMap(({ payload }) =>
      payload.type === "AttemptAbandoned" ? [payload.attemptId] : [],
    );
    expect(abandoned).toEqual([0, 1, 2, 4, 5].map((index) => attempts[index]!.attemptId));
    const dispatches = lines(database, "guest").flatMap((line) => {
      const { event } = line as { event: { type: string; pullId: string; attemptId: string } };
      return event.type === "dispatch" ? [[event.pullId, event.attemptId]] : [];
    });
    expect(dispatches).toEqual(
      [0, 2, 3, 4, 5, 6].map((index) => [attempts[index]!.pullId, attempts[index]!.attemptId]),
    );
    expect((await launch(database, "probe-retained-second")).status).toBe(0);

    expect(payloads(completed.records, "PullResolved")).toMatchObject([
      { pullId: requested[0]!.pullId, outcome: { status: "ok", value: "hello:recorded:3" } },
      { pullId: requested[1]!.pullId, outcome: { status: "ok", value: "hello:recorded:6" } },
    ]);
    expect(payloads(completed.records, "PullResolved")[0]).toEqual(
      payloads(firstAccepted, "PullResolved")[0],
    );
    expect(lines(database, "calls")).toEqual(
      Array.from({ length: 6 }, (_, index) => ({
        occurrence: index,
        key: "same",
        input: "hello",
        value: `hello:recorded:${index + 1}`,
      })),
    );
    expect(new Set(delivered(database))).toEqual(new Set(["hello:recorded:3", "hello:recorded:6"]));
    expect((await launch(database)).status).toBe(0);
    expect((await inspect(database, "terminal-repeat")).records).toEqual(completed.records);
    expect(lines(database, "calls")).toHaveLength(6);
  });
});

it("refuses recovery if the retained old settlement wins immediately before takeover", async () => {
  const database = join(directory, "old-winner.sqlite");
  expect((await launch(database, "loss-before-acceptance")).status).toBe(74);
  clock(database, 31001);
  expect((await launch(database, "old-settlement-wins")).status).toBe(1);
  expect(failure(database)).toEqual({
    code: "invalid_command",
    message: "Recovery occurrence or attempt is stale",
  });
  expect(databaseState(database)).toEqual(
    JSON.parse(readFileSync(`${database}.winner-state.json`, "utf8")),
  );
  const accepted = await inspect(database, "old-winner");
  expect(payloads(accepted.records, "AttemptStarted")).toHaveLength(1);
  expect(payloads(accepted.records, "AttemptAbandoned")).toEqual([]);
  expect(payloads(accepted.records, "PullResolved")).toMatchObject([
    { outcome: { status: "ok", value: "old-winner" } },
  ]);
  expect(lines(database, "calls")).toHaveLength(1);
  expect(delivered(database)).toEqual([]);
  expect((await launch(database)).status).toBe(0);
  expect(JSON.parse(readFileSync(`${database}.report.json`, "utf8"))).toMatchObject({
    result: "old-winner|hello:recorded:2:done",
  });
  expect(lines(database, "calls")).toHaveLength(2);
});
