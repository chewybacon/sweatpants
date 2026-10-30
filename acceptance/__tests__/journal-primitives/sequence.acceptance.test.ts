// @vitest-environment node
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { launchLocal, launchProcess } from "../../fixtures/journal-primitives/launch.ts";
import type { Engine } from "../../fixtures/journal-primitives/scenario.ts";
import type { DurableSemanticRecord } from "../../../packages/journal-authority/src/contract/semantic-record.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = resolve(root, ".artifacts/journal-primitives");
mkdirSync(artifacts, { recursive: true });
const directory = mkdtempSync(join(artifacts, "sequence-"));
interface Report {
  result?: unknown;
  plan?: { rows: Array<{ classification: string; parked?: { pullId: string } }> };
  records: DurableSemanticRecord[];
  state?: { status: string };
}
let processLaunches = 0;
let localLaunches = 0;
async function launch(
  engine: Engine,
  database: string,
  stop: number,
  variant = "normal",
  cold = false,
) {
  if (cold) {
    processLaunches++;
  } else {
    localLaunches++;
  }
  return await (cold ? launchProcess : launchLocal)({ engine, path: database, stop, variant });
}
async function run(engine: Engine, database: string, stop = -1, cold = false) {
  const child = await launch(engine, database, stop, "normal", cold);
  writeFileSync(`${database}.${engine}.${stop}.log`, child.stdout + child.stderr);
  expect(child.status, child.stderr).toBe(stop < 0 ? 0 : 73);
}
afterAll(() => {
  writeFileSync(
    join(directory, "launch-counts.json"),
    JSON.stringify({ processLaunches, localLaunches }),
  );
  // One cold trajectory: two deaths, recovery, then completed reconnect.
  expect(processLaunches).toBeLessThanOrEqual(4);
});

function report(database: string): Report {
  return JSON.parse(readFileSync(`${database}.report.json`, "utf8")) as Report;
}
function calls(database: string) {
  return readFileSync(`${database}.calls.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}
/** Only lease events and envelope metadata are excluded; all workload payloads compare exactly. */
function semantic(records: DurableSemanticRecord[]) {
  return records.flatMap(({ payload }) => {
    switch (payload.type) {
      case "AdvancementBound":
      case "AdvancementReleased":
        return [];
      case "TaskOpened":
      case "PullRequested":
      case "AttemptStarted":
      case "PullResolved":
      case "TaskClosed":
        return [payload];
      default:
        throw new Error(`Unexpected record ${payload.type}`);
    }
  });
}
const expectedCalls = [1, 2].map((number) => ({
  occurrence: number - 1,
  key: "same",
  input: "hello",
  value: `hello:recorded:${number}`,
}));

describe("experimental sequential journal against the production engine", () => {
  it.each([[], [0], [1], [0, 1]].map((stops) => ({ stops })))(
    "persists and reopens acceptance boundaries %j (both boundaries also run cold)",
    async ({ stops }) => {
      const cold = stops.length === 2;
      const name = stops.length ? stops.join("-") : "uninterrupted";
      const reference = join(directory, `${name}-reference.sqlite`);
      const candidate = join(directory, `${name}-candidate.sqlite`);
      await run("reference", reference);
      const referenceReport = report(reference);
      for (const stop of stops) {
        await run("candidate", candidate, stop, cold);
        await run("inspect", candidate);
        const prefix = report(candidate);
        writeFileSync(`${candidate}.prefix-${stop}.json`, JSON.stringify(prefix, null, 2));
        expect(prefix.state?.status).toBe("active");
        const guest = readFileSync(`${candidate}.guest.jsonl`, "utf8");
        expect(guest).not.toContain(`"occurrence":${stop},`);
        expect(
          prefix.records.filter(({ payload }) => payload.type === "PullResolved"),
        ).toHaveLength(stop + 1);
        expect(prefix.records.some(({ payload }) => payload.type === "TaskClosed")).toBe(false);
        expect(calls(candidate)).toEqual(expectedCalls.slice(0, stop + 1));
      }
      await run("candidate", candidate, -1, cold);
      const completed = report(candidate);
      expect(completed.result).toBe("hello:recorded:1|hello:recorded:2:done");
      expect(referenceReport.result).toEqual({ state: "completed", value: completed.result });
      expect(semantic(completed.records)).toEqual(semantic(referenceReport.records));
      expect(calls(candidate)).toEqual(expectedCalls);
      expect(calls(reference)).toEqual(expectedCalls);
      const requests = completed.records.flatMap(({ payload }) =>
        payload.type === "PullRequested" ? [payload] : [],
      );
      expect(requests).toHaveLength(2);
      expect(requests[0]?.descriptor).toEqual(requests[1]?.descriptor);
      expect(new Set(requests.map((entry) => entry.pullId)).size).toBe(2);
      expect(requests.map((entry) => entry.actionIndex)).toEqual([0, 1]);
      await run("candidate", candidate, -1, cold);
      expect(report(candidate)).toEqual(completed);
      expect(calls(candidate)).toEqual(expectedCalls);
      await run("reference", reference);
      expect(report(reference)).toEqual(referenceReport);
      expect(calls(reference)).toEqual(expectedCalls);
      writeFileSync(
        join(directory, `${name}.passed.json`),
        JSON.stringify(
          {
            name,
            candidate,
            reference,
            normalization:
              "Drop envelope metadata and AdvancementBound/Released only; all other payloads exact",
            status: "passed",
          },
          null,
          2,
        ),
      );
    },
  );
  it("rejects divergent replay and unsupported unsafe records before live dispatch", async () => {
    const database = join(directory, "negative.sqlite");
    await run("candidate", database, 0);
    for (const variant of ["divergent", "unsafe"]) {
      const target = variant === "unsafe" ? join(directory, "unsafe.sqlite") : database;
      const child = await launch("candidate", target, -1, variant);
      expect(child.status).toBe(1);
      expect(child.stderr).toContain(
        variant === "unsafe" ? "only repeatable records" : "Evaluator operation differs",
      );
      if (variant === "unsafe") {
        expect(existsSync(`${target}.calls.jsonl`)).toBe(false);
      }
    }
    expect(calls(database)).toEqual(expectedCalls.slice(0, 1));
    await run("candidate", database);
    expect(calls(database)).toEqual(expectedCalls);
  });
  it.each(["reserve-error", "handler-error", "rejected-resolution", "rollback"])(
    "releases %s failures without accepting or delivering an outcome",
    async (variant) => {
      const database = join(directory, `${variant}.sqlite`);
      const child = await launch("candidate", database, -1, variant);
      writeFileSync(`${database}.failure.log`, child.stdout + child.stderr);
      expect(child.status, child.stderr).toBe(1);
      expect(child.stderr).toContain(
        variant === "reserve-error"
          ? "fixture reserve failure"
          : variant === "handler-error"
            ? "fixture handler failure"
            : variant === "rollback"
              ? "Injected SQLite fault at execution-before-commit"
              : "capability",
      );
      const guest = readFileSync(`${database}.guest.jsonl`, "utf8");
      expect(guest).not.toContain('"type":"delivered"');
      if (variant === "handler-error" || variant === "reserve-error") {
        expect(existsSync(`${database}.calls.jsonl`)).toBe(false);
      } else {
        expect(calls(database)).toEqual(expectedCalls.slice(0, 1));
      }
      await run("inspect", database);
      const rejected = report(database);
      expect(rejected.state?.status).toBe("active");
      expect(
        rejected.records.filter(
          ({ payload }) => payload.type === "PullResolved" || payload.type === "TaskClosed",
        ),
      ).toHaveLength(0);
      expect(
        rejected.records.filter(
          ({ payload }) => payload.type === "AdvancementReleased" && payload.reason === "failed",
        ),
      ).toHaveLength(1);
      writeFileSync(`${database}.unaccepted.json`, JSON.stringify(rejected, null, 2));
      if (variant === "reserve-error") {
        // No pending pull: the failed activation's own lease was the only obstacle.
        expect(rejected.plan?.rows[0]?.classification).toBe("replayable");
        await run("candidate", database);
        expect(report(database).result).toBe("hello:recorded:1|hello:recorded:2:done");
        expect(calls(database)).toEqual(expectedCalls);
      } else {
        // Release cannot settle or discard an unaccepted pull. The real authority parks it.
        expect(rejected.plan?.rows[0]?.parked).toBeDefined();
        const retry = await launch("candidate", database, -1);
        expect(retry.status).toBe(1);
        expect(retry.stderr).toContain("requires a replayable local strand");
        if (variant === "handler-error") {
          expect(existsSync(`${database}.calls.jsonl`)).toBe(false);
        } else {
          expect(calls(database)).toEqual(expectedCalls.slice(0, 1));
        }
      }
    },
  );
  it("preserves the handler error when best-effort cleanup also fails", async () => {
    const database = join(directory, "cleanup-error.sqlite");
    const child = await launch("candidate", database, -1, "cleanup-error");
    expect(child.status).toBe(1);
    writeFileSync(`${database}.failure.log`, child.stdout + child.stderr);
    expect(child.stderr).toContain("fixture handler failure");
    expect(child.stderr).not.toContain("fixture cleanup failure");
    expect(existsSync(`${database}.calls.jsonl`)).toBe(false);
  });
  it.each([
    "changed-input",
    "changed-program",
    "truncated",
    "reordered",
    "duplicate",
    "digest-invalid",
    "extra-history",
  ])("rejects %s query/guest history before external dispatch", async (variant) => {
    const database = join(directory, `${variant}.sqlite`);
    await run("candidate", database, 1);
    await run("inspect", database);
    const before = report(database).records;
    const child = await launch("candidate", database, -1, variant);
    writeFileSync(`${database}.failure.log`, child.stdout + child.stderr);
    expect(child.status, child.stderr).toBe(1);
    expect(calls(database)).toEqual(expectedCalls);
    await run("inspect", database);
    expect(report(database).records).toEqual(before);
    expect(report(database).state?.status).toBe("active");
    await run("candidate", database);
    expect(report(database).result).toBe("hello:recorded:1|hello:recorded:2:done");
    expect(calls(database)).toEqual(expectedCalls);
  });
  it.each(["stale-bind", "expired-reserve", "replaced-reserve", "expired-complete"])(
    "fences %s at the authority boundary",
    async (variant) => {
      const database = join(directory, `${variant}.sqlite`);
      if (variant === "expired-complete") {
        await run("candidate", database, 1);
      }
      const child = await launch("candidate", database, -1, variant);
      writeFileSync(`${database}.failure.log`, child.stdout + child.stderr);
      expect(child.status, child.stderr).toBe(1);
      expect(child.stderr).toContain(
        variant === "stale-bind" ? "Experimental stale mandate" : "Mandate is stale",
      );
      if (variant === "expired-complete") {
        expect(calls(database)).toEqual(expectedCalls);
      } else {
        expect(existsSync(`${database}.calls.jsonl`)).toBe(false);
      }
      await run("inspect", database);
      const persisted = report(database);
      expect(persisted.state?.status).toBe("active");
      expect(persisted.records.some(({ payload }) => payload.type === "TaskClosed")).toBe(false);
      if (variant === "stale-bind" || variant === "replaced-reserve") {
        // Candidate cleanup must not release the competing owner's live lease.
        expect(persisted.plan?.rows[0]?.classification).toBe("structurally_blocked");
        expect(persisted.plan?.rows[0]?.parked).toBeUndefined();
        const retry = await launch("candidate", database, -1);
        expect(retry.status).toBe(1);
        expect(retry.stderr).toContain("requires a replayable local strand");
        expect(existsSync(`${database}.calls.jsonl`)).toBe(false);
      } else {
        await run("candidate", database);
        expect(report(database).result).toBe("hello:recorded:1|hello:recorded:2:done");
      }
    },
  );
});
