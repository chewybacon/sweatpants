// @vitest-environment node
import { fork } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { run, spawn, withResolvers } from "effection";
import { expect, it } from "vitest";
import {
  digestCanonicalJson,
  encodeCanonicalJson,
  sha256,
  type Json,
} from "@sweatpants/foundation";
import type { ProgramRestoreRequest, ReplayEntry } from "@sweatpants/durable-execution";
import { rebuildProgram, withRebuildStore } from "./fixtures/rebuild.ts";

const root = resolve("../.artifacts/journal-rebuild/loop-1");
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(resolve(root, "acceptance-"));
function json(name: string) {
  return JSON.parse(readFileSync(resolve(directory, name), "utf8"));
}
function worker(mode: string) {
  const child = fork(
    resolve("__tests__/host-crash/fixtures/rebuild.ts"),
    ["rebuild-worker", directory, mode],
    {
      execArgv: ["--conditions=development", "--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  child.stdout?.on("data", (data) => {
    output += String(data);
  });
  child.stderr?.on("data", (data) => {
    output += String(data);
  });
  const exit = new Promise((done) =>
    child.once("exit", (code, signal) => {
      writeFileSync(resolve(directory, `${mode}.log`), output);
      done({ code, signal });
    }),
  );
  const ready = new Promise<unknown>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Worker timeout: ${output}`));
    }, 20_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      done(message);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Worker exited: ${output}`));
    });
  });
  return { child, ready, exit };
}

it("reconstructs a real SQLite acceptance committed before delivery after SIGKILL and rejects invalid histories with physical release", async () => {
  const first = worker("seed");
  try {
    expect(await first.ready).toMatchObject({ committed: true, pid: first.child.pid });
    expect(json("committed.json").command).toMatchObject({
      type: "resume",
      actionIndex: 0,
      outcome: { status: "ok", value: "accepted-value" },
    });
    expect(readFileSync(resolve(directory, "observations.jsonl"), "utf8")).not.toContain(
      "continued:",
    );
    first.child.kill("SIGKILL");
    expect(await first.exit).toEqual({ code: null, signal: "SIGKILL" });
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = resolve(directory, "authority.sqlite" + suffix);
      if (existsSync(file)) {
        copyFileSync(file, resolve(directory, "committed.sqlite" + suffix));
      }
    }
    expect(json("committed-sqlite.json").integrity).toEqual({ integrity_check: "ok" });
    const effects = readFileSync(resolve(directory, "effects.jsonl"), "utf8");
    expect(effects.trim().split("\n")).toHaveLength(1);
    const second = worker("recover");
    try {
      expect(await second.ready).toMatchObject({ result: { state: "parked" } });
      expect(await second.exit).toEqual({ code: 0, signal: null });
      expect(second.child.pid).not.toBe(first.child.pid);
    } finally {
      second.child.kill("SIGKILL");
    }
    expect(readFileSync(resolve(directory, "effects.jsonl"), "utf8")).toBe(effects);
    expect(readFileSync(resolve(directory, "observations.jsonl"), "utf8")).toContain(
      "continued:accepted-value",
    );
    const recoveredObservations = readFileSync(resolve(directory, "observations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.pid === json("recovered.json").pid);
    expect(recoveredObservations.filter((entry) => entry.event === "acquire")).toHaveLength(1);
    expect(
      recoveredObservations.filter((entry) => entry.event === "follow-up-attempt"),
    ).toHaveLength(1);
    expect(recoveredObservations.some((entry) => entry.event === "follow-up:continued-value")).toBe(
      true,
    );
    expect(json("follow-up-delivery.json")).toMatchObject({
      replayed: false,
      receipt: { status: "accepted" },
    });
    const original = json("recovery-request.json") as ProgramRestoreRequest;
    const entries = Array.from(original.replay as Iterable<ReplayEntry>);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      receipt: json("committed.json").command.receipt,
      outcome: json("committed.json").command.outcome,
    });
    expect(json("recovered.json").records.slice(0, json("committed.json").records.length)).toEqual(
      json("committed.json").records,
    );
    const observations: unknown[] = [];
    await run(function* () {
      yield* withRebuildStore(directory, function* (rig) {
        const before = yield* rig.journal.readSession(rig.attach.sessionId);
        for (const fault of [
          "changed",
          "terminal",
          "chain",
          "receipt",
          "head",
          "source",
        ] as const) {
          const trace: string[] = [];
          const request = structuredClone({ ...original, replay: entries });
          if (fault === "chain") {
            request.replay[0] = { ...request.replay[0]!, entryDigest: "0".repeat(64) };
          }
          if (fault === "receipt") {
            const entry = request.replay[0]!;
            if (entry.type !== "operation") {
              throw new Error("Expected record");
            }
            const { entryDigest: _, ...body } = {
              ...entry,
              receipt: { ...entry.receipt, outcomeDigest: "0".repeat(64) },
            };
            request.replay[0] = {
              ...body,
              entryDigest: sha256(
                encodeCanonicalJson({
                  replayChainSeed: request.replayChainSeed,
                  previousEntryDigest: entry.previousEntryDigest,
                  entryWithoutEntryDigest: body as unknown as Json,
                }),
              ),
            };
          }
          if (fault === "head") {
            request.replayChainDigest = "0".repeat(64);
          }
          let closed = 0;
          const replay: Iterable<ReplayEntry> = {
            *[Symbol.iterator]() {
              try {
                if (fault === "source") {
                  throw new Error("source-broken");
                }
                yield* request.replay;
              } finally {
                closed++;
              }
            },
          };
          const driver = rebuildProgram(directory, fault, trace).createDriver(true);
          let caught: unknown;
          try {
            yield* driver.restore({ ...request, replay });
          } catch (error) {
            caught = error;
          }
          expect(caught).toMatchObject({
            code: fault === "receipt" ? "program_protocol_error" : "replay_diverged",
          });
          if (fault === "source") {
            expect(caught).toMatchObject({ details: { cause: "source-broken" } });
          }
          expect(closed).toBe(1);
          expect(trace.filter((event) => event === "acquire")).toHaveLength(1);
          expect(trace.filter((event) => event === "release")).toHaveLength(1);
          expect(trace.filter((event) => event === "child-release")).toHaveLength(1);
          expect(trace).not.toContain("logical-cancel");
          if (fault !== "head") {
            expect(trace).not.toContain("continued:accepted-value");
          }
          observations.push({ fault, trace, error: String(caught), closed });
          writeFileSync(resolve(directory, "progress.json"), JSON.stringify(observations));
        }
        const trace: string[] = [];
        let closed = 0;
        const waiting = withResolvers<void>();
        let position = 0;
        const replay: AsyncIterable<ReplayEntry> = {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (position++ === 0) {
                  return Promise.resolve({ done: false, value: entries[0]! });
                }
                waiting.resolve();
                return new Promise<IteratorResult<ReplayEntry>>(() => {});
              },
              return() {
                closed++;
                writeFileSync(
                  resolve(directory, "iterator-return.json"),
                  JSON.stringify({ trace, closed }),
                );
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        };
        const driver = rebuildProgram(directory, "original", trace).createDriver(true);
        let returned: unknown;
        const owner = yield* spawn(function* () {
          returned = yield* driver.restore({ ...original, replay });
        });
        yield* waiting.operation;
        writeFileSync(
          resolve(directory, "interrupt-before.json"),
          JSON.stringify({ trace, closed }),
        );
        yield* owner.halt();
        writeFileSync(
          resolve(directory, "interrupt-after.json"),
          JSON.stringify({ trace, closed }),
        );
        expect(returned).toBeUndefined();
        expect(closed).toBe(1);
        expect(trace.filter((event) => event === "release")).toHaveLength(1);
        expect(trace.filter((event) => event === "child-release")).toHaveLength(1);
        expect(trace).not.toContain("logical-cancel");
        observations.push({ fault: "interrupted", trace, closed });
        const restored = yield* driver.restore(original);
        expect(restored.frontier).toMatchObject({
          type: "operation",
          actionIndex: 1,
          descriptor: { kind: "record", key: "follow-up" },
        });
        expect(
          yield* driver.step(restored.attachment, {
            ...json("follow-up-delivery.json"),
            replayed: true,
          }),
        ).toMatchObject({ type: "operation", actionIndex: 2, descriptor: { kind: "elicit" } });
        expect(trace).not.toContain("follow-up-attempt");
        yield* driver.shutdown(restored.attachment, "parked");
        expect(yield* rig.journal.readSession(rig.attach.sessionId)).toEqual(before);
        writeFileSync(
          resolve(directory, "validation.json"),
          JSON.stringify(
            { observations, recordsDigest: digestCanonicalJson(before as unknown as Json) },
            null,
            2,
          ),
        );
      });
    });
    expect(readFileSync(resolve(directory, "effects.jsonl"), "utf8")).toBe(effects);
  } finally {
    first.child.kill("SIGKILL");
  }
});
