// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { run } from "effection";
import {
  encode,
  failure,
  driveJournal,
  success,
  type Handler,
  type Outcome,
  type Work,
  type Journal,
  type Snapshot,
} from "@sweatpants/primitive-journal";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { createSequenceRunner } from "@sweatpants/primitive-journal/example";
import type { DurableSemanticRecord } from "../../../packages/journal-authority/src/contract/semantic-record.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".artifacts/primitive-journal");
mkdirSync(artifacts, { recursive: true });
const directory = mkdtempSync(join(artifacts, "comparison-"));
function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function calls(path: string) {
  return readFileSync(`${path}.calls.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}
async function launch(path: string, stop = "none", mode = "repeatable", reference = false) {
  const args = reference
    ? ["acceptance/fixtures/journal-primitives/worker.ts", "reference", path, "-1"]
    : ["acceptance/fixtures/primitive-journal/worker.ts", path, stop, mode];
  return await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=development", "--import", "tsx", ...args],
      { cwd: root, timeout: 20000 },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      writeFileSync(`${path}.${stop}.log`, stderr);
      resolve({ code, stderr });
    });
  });
}
const reference = join(directory, "reference.sqlite");
let oracle: { result: { value: string }; records: DurableSemanticRecord[] };
beforeAll(async () => {
  const child = await launch(reference, "none", "repeatable", true);
  expect(child.code, child.stderr).toBe(0);
  oracle = read(`${reference}.report.json`);
});
it.each([{ stops: [] }, { stops: [0, 1] }])(
  "matches production workload across acceptance stops %j",
  async ({ stops }) => {
    const path = join(directory, `candidate-${stops.join("-")}.sqlite`);
    for (const stop of stops) {
      const child = await launch(path, String(stop));
      expect(child.code, child.stderr).toBe(73);
      const prefix = read<Snapshot>(`${path}.prefix.json`);
      expect(prefix.status).toBe("running");
      expect(prefix.entries).toHaveLength(stop + 1);
    }
    const child = await launch(path);
    expect(child.code, child.stderr).toBe(0);
    const completed = read<{ result: string; snapshot: Snapshot }>(`${path}.report.json`);
    expect(completed.result).toBe(oracle.result.value);
    expect(calls(path)).toEqual(calls(reference));
    const requests = oracle.records.flatMap(({ payload }) =>
      payload.type === "PullRequested" ? [payload.descriptor] : [],
    );
    const values = oracle.records.flatMap(({ payload }) =>
      payload.type === "PullResolved" ? [payload.outcome] : [],
    );
    expect(completed.snapshot.entries.map((entry) => entry.request)).toEqual(requests);
    expect(
      completed.snapshot.entries.map((entry) =>
        entry.outcome.ok
          ? { status: "ok", value: entry.outcome.value }
          : { status: "error", error: entry.outcome.error },
      ),
    ).toEqual(values);
    expect(completed.snapshot.attempts).toHaveLength(2);
    expect((await launch(path)).code).toBe(0);
    expect(read(`${path}.report.json`)).toEqual(completed);
    expect(calls(path)).toEqual(calls(reference));
  },
);
it("retries a lost repeatable result, keeping occurrence identity", async () => {
  const path = join(directory, "retry.sqlite");
  expect((await launch(path, "effect")).code).toBe(74);
  expect((await launch(path)).code).toBe(0);
  const report = read<{ result: string; snapshot: Snapshot }>(`${path}.report.json`);
  expect(report.result).toBe("hello:recorded:2|hello:recorded:3:done");
  expect(report.snapshot.attempts.map((a) => [a.sequence, a.number, a.status])).toEqual([
    [0, 0, "unknown"],
    [0, 1, "accepted"],
    [1, 0, "accepted"],
  ]);
  expect(calls(path)).toHaveLength(3);
});
it("blocks an unsafe lost result across repeated restarts", async () => {
  const path = join(directory, "unsafe.sqlite");
  expect((await launch(path, "effect", "unsafe")).code).toBe(74);
  for (let i = 0; i < 2; i++) {
    const child = await launch(path, "none", "unsafe");
    expect(child.code).toBe(1);
    expect(child.stderr).toContain("outcome_unknown");
  }
  expect(calls(path)).toHaveLength(1);
});
it("application adapter records an explicit failure before throwing it into the guest", async () => {
  const journal = new SqliteJournal(join(directory, "failure.sqlite"), {
    executionId: "failure",
    program: { id: "sequence", version: "1", digest: "fixture" },
    input: "hello",
  });
  try {
    const execute = createSequenceRunner(journal, function* () {
      return failure("unavailable");
    });
    await expect(run(execute)).rejects.toBe("unavailable");
    expect(journal.read().entries[0]?.outcome).toEqual(failure("unavailable"));
  } finally {
    journal.close();
  }
});
it("a rejected acceptance cannot deliver a handler result", async () => {
  const journal = new SqliteJournal(join(directory, "reject.sqlite"), {
    executionId: "reject",
    program: { id: "sequence", version: "1", digest: "fixture" },
    input: "hello",
  });
  let delivered = false;
  const boundary: Journal = {
    read: () => journal.read(),
    begin: (...args) => journal.begin(...args),
    accept() {
      throw new Error("rejected acceptance");
    },
    complete: (...args) => journal.complete(...args),
  };
  try {
    await expect(
      run(() =>
        driveJournal(
          function* () {
            yield { kind: "record", retrySafety: { mode: "repeatable" } };
            delivered = true;
            return "done";
          },
          boundary,
          function* () {
            return success("reply");
          },
        ),
      ),
    ).rejects.toThrow("rejected acceptance");
    expect(delivered).toBe(false);
    expect(journal.read().entries).toEqual([]);
    expect(journal.read().attempts[0]?.status).toBe("started");
  } finally {
    journal.close();
  }
});
it("an accepted failure can yield from catch and replay without dispatch", async () => {
  const journal = new SqliteJournal(join(directory, "catch.sqlite"), {
    executionId: "catch",
    program: { id: "catch", version: "1", digest: "fixture" },
    input: null,
  });
  let calls = 0;
  const work = function* () {
    try {
      yield { key: "first", retrySafety: { mode: "repeatable" } };
    } catch (error) {
      if (error !== "unavailable") {
        throw error;
      }
      yield { key: "fallback", retrySafety: { mode: "repeatable" } };
    }
    return "recovered";
  };
  try {
    expect(
      await run(() =>
        driveJournal(work, journal, function* () {
          calls++;
          return calls === 1 ? failure("unavailable") : success("fallback");
        }),
      ),
    ).toBe("recovered");
    expect(
      await run(() =>
        driveJournal(work, journal, function* () {
          throw new Error("replay must not dispatch");
        }),
      ),
    ).toBe("recovered");
    expect(calls).toBe(2);
    expect(journal.read().entries).toHaveLength(2);
  } finally {
    journal.close();
  }
});

it.each(["repeatable", "unsafe"] as const)(
  "rolls back real SQLite acceptance and reopens an unresolved %s occurrence",
  async (mode) => {
    const path = join(directory, `rollback-${mode}.sqlite`);
    const identity = {
      executionId: `rollback-${mode}`,
      program: { id: "rollback", version: "1", digest: "fixture" },
      input: null,
    };
    const request = { kind: "record", key: "same", retrySafety: { mode } };
    const externalCalls: { request: typeof request; reply: string }[] = [];
    const delivered: unknown[] = [];
    const accepted: unknown[] = [];
    const work = function* () {
      const reply: unknown = yield request;
      delivered.push(reply);
      return String(reply);
    };
    const handler = function* (descriptor: typeof request) {
      const reply = `reply-${externalCalls.length + 1}`;
      externalCalls.push({ request: descriptor, reply });
      return success(reply);
    };
    let journal = new SqliteJournal(path, identity);
    const fixture = new DatabaseSync(path);
    const evidence: unknown[] = [];
    const observe = (phase: string) => {
      const snapshot = journal.read();
      const execution = fixture
        .prepare("SELECT head, status, result_json FROM executions WHERE id = ?")
        .get(identity.executionId);
      const exchanges = fixture
        .prepare("SELECT * FROM exchanges WHERE execution_id = ? ORDER BY sequence")
        .all(identity.executionId);
      const attempts = fixture
        .prepare("SELECT * FROM attempts WHERE execution_id = ? ORDER BY sequence, number")
        .all(identity.executionId);
      evidence.push(
        JSON.parse(
          JSON.stringify({
            phase,
            snapshot,
            execution,
            exchanges,
            attempts,
            externalCalls,
            delivered,
            accepted,
          }),
        ),
      );
      return { snapshot, execution, exchanges, attempts };
    };
    const execute = () =>
      run(() =>
        driveJournal(work, journal, handler, [], (entry) => {
          accepted.push(entry);
        }),
      );
    const reopen = () => {
      journal.close();
      journal = new SqliteJournal(path, identity);
    };
    try {
      fixture.exec(`
        CREATE TRIGGER primitive_loop_1_reject_acceptance
        BEFORE UPDATE OF status ON attempts
        WHEN NEW.status = 'accepted'
        BEGIN
          SELECT RAISE(ABORT, 'primitive_loop_1_acceptance_fault');
        END;
      `);
      await expect(execute()).rejects.toThrow("primitive_loop_1_acceptance_fault");
      expect(externalCalls).toEqual([{ request, reply: "reply-1" }]);
      expect(delivered).toEqual([]);
      expect(accepted).toEqual([]);
      const failed = observe("failed-acceptance");
      const originalAttempt = {
        sequence: 0,
        number: 0,
        request,
        retryMode: mode,
        status: "started",
      };
      expect(failed.snapshot).toEqual({
        identity,
        status: "running",
        entries: [],
        attempts: [originalAttempt],
      });
      expect(failed.execution).toEqual({ head: 0, status: "running", result_json: null });
      expect(failed.exchanges).toEqual([]);
      expect(failed.attempts).toEqual([
        {
          execution_id: identity.executionId,
          sequence: 0,
          number: 0,
          request_json: encode(request),
          retry_mode: mode,
          status: "started",
        },
      ]);
      fixture.exec("DROP TRIGGER primitive_loop_1_reject_acceptance");
      reopen();
      if (mode === "repeatable") {
        expect(await execute()).toBe("reply-2");
        expect(externalCalls).toEqual([
          { request, reply: "reply-1" },
          { request, reply: "reply-2" },
        ]);
        expect(delivered).toEqual(["reply-2"]);
        const entry = { sequence: 0, request, outcome: success("reply-2") };
        expect(accepted).toEqual([entry]);
        const completed = observe("recovered");
        expect(completed.snapshot).toEqual({
          identity,
          status: "completed",
          value: "reply-2",
          entries: [entry],
          attempts: [
            { ...originalAttempt, status: "unknown" },
            { ...originalAttempt, number: 1, status: "accepted" },
          ],
        });
        expect(completed.execution).toEqual({
          head: 1,
          status: "completed",
          result_json: '"reply-2"',
        });
        expect(completed.exchanges).toHaveLength(1);
        reopen();
        expect(await execute()).toBe("reply-2");
        expect(externalCalls).toHaveLength(2);
        expect(delivered).toEqual(["reply-2", "reply-2"]);
        expect(accepted).toEqual([entry]);
        expect(observe("completed-replay").snapshot).toEqual(completed.snapshot);
      } else {
        for (let restart = 0; restart < 2; restart++) {
          await expect(execute()).rejects.toThrow("outcome_unknown: exchange 0 may have happened");
          expect(externalCalls).toEqual([{ request, reply: "reply-1" }]);
          expect(delivered).toEqual([]);
          expect(accepted).toEqual([]);
          const blocked = observe(`blocked-${restart}`);
          expect(blocked.snapshot).toEqual({
            identity,
            status: "running",
            entries: [],
            attempts: [{ ...originalAttempt, status: "unknown" }],
          });
          expect(blocked.execution).toEqual({ head: 0, status: "running", result_json: null });
          expect(blocked.exchanges).toEqual([]);
          expect(blocked.attempts).toHaveLength(1);
          reopen();
        }
      }
    } finally {
      writeFileSync(`${path}.evidence.json`, JSON.stringify(evidence, null, 2));
      fixture.close();
      journal.close();
    }
  },
);

it.each(["changed-request", "premature-completion", "changed-result"] as const)(
  "rejects %s during reconstruction without changing durable history",
  async (change) => {
    const path = join(directory, `divergence-${change}.sqlite`);
    const identity = {
      executionId: `divergence-${change}`,
      program: { id: "divergence", version: "1", digest: "fixture" },
      input: null,
    };
    const request = { kind: "record", key: "same", retrySafety: { mode: "repeatable" } };
    const externalCalls: unknown[] = [];
    const delivered: unknown[] = [];
    const divergentDelivered: unknown[] = [];
    const notifications: unknown[] = [];
    const sentinelCalls: unknown[] = [];
    const evidence: unknown[] = [];
    const original: Work<string, typeof request> = function* () {
      const reply = yield request;
      delivered.push(reply);
      return `${String(reply)}:done`;
    };
    const handler: Handler<typeof request, never, Outcome<string, never>> = function* (value) {
      externalCalls.push(value);
      return success("reply");
    };
    const sentinel: Handler<typeof request, never, Outcome<string, never>> = function* (value) {
      sentinelCalls.push(value);
      throw new Error("replay must not dispatch");
    };
    const divergent: Work<string, typeof request> = function* () {
      if (change === "premature-completion") {
        return "premature";
      }
      const reply = yield change === "changed-request" ? { ...request, key: "different" } : request;
      divergentDelivered.push(reply);
      return "different-result";
    };
    let journal = new SqliteJournal(path, identity);
    const observe = (phase: string) => {
      const snapshot = journal.read();
      evidence.push(
        JSON.parse(
          JSON.stringify({
            phase,
            snapshot,
            externalCalls,
            delivered,
            divergentDelivered,
            notifications,
            sentinelCalls,
          }),
        ),
      );
      return snapshot;
    };
    const reopen = () => {
      journal.close();
      journal = new SqliteJournal(path, identity);
    };
    const interruption = new Error("primitive_loop_2_after_acceptance");
    try {
      const baseline = run(() =>
        driveJournal(original, journal, handler, [], () => {
          if (change !== "changed-result") {
            throw interruption;
          }
        }),
      );
      if (change === "changed-result") {
        expect(await baseline).toBe("reply:done");
        expect(delivered).toEqual(["reply"]);
      } else {
        await expect(baseline).rejects.toBe(interruption);
        expect(delivered).toEqual([]);
      }
      const entry = { sequence: 0, request, outcome: success("reply") };
      const attempt = {
        sequence: 0,
        number: 0,
        request,
        retryMode: "repeatable",
        status: "accepted",
      };
      const baselineSnapshot = observe("baseline");
      const prefix = { identity, entries: [entry], attempts: [attempt] };
      if (change === "changed-result") {
        expect(baselineSnapshot).toEqual({ ...prefix, status: "completed", value: "reply:done" });
      } else {
        expect(baselineSnapshot).toEqual({ ...prefix, status: "running" });
      }
      expect(externalCalls).toEqual([request]);
      reopen();
      const before = observe("reopened-before-divergence");
      expect(before).toEqual(baselineSnapshot);
      const diagnostic =
        change === "changed-result" ? "Terminal replay mismatch" : "Replay request mismatch";
      await expect(
        run(() =>
          driveJournal(divergent, journal, sentinel, [], (accepted) => {
            notifications.push(accepted);
          }),
        ),
      ).rejects.toEqual(new Error(diagnostic));
      expect(divergentDelivered).toEqual(change === "changed-result" ? ["reply"] : []);
      expect(sentinelCalls).toEqual([]);
      expect(notifications).toEqual([]);
      expect(externalCalls).toEqual([request]);
      expect(observe("rejected-divergence")).toEqual(before);
      reopen();
      expect(observe("reopened-after-rejection")).toEqual(before);
      expect(
        await run(() =>
          driveJournal(original, journal, sentinel, [], (accepted) => {
            notifications.push(accepted);
          }),
        ),
      ).toBe("reply:done");
      expect(delivered).toEqual(change === "changed-result" ? ["reply", "reply"] : ["reply"]);
      expect(sentinelCalls).toEqual([]);
      expect(notifications).toEqual([]);
      expect(externalCalls).toEqual([request]);
      expect(observe("original-work-restored")).toEqual({
        identity,
        entries: [entry],
        attempts: [attempt],
        status: "completed",
        value: "reply:done",
      });
    } finally {
      writeFileSync(`${path}.evidence.json`, JSON.stringify(evidence, null, 2));
      journal.close();
    }
  },
);
