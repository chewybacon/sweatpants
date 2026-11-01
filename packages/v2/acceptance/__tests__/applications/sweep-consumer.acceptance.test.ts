import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { createActivationIntents } from "@sweatpan.ts/durable";
import { createActivationReconciler, type ActivationReconciliation } from "@sweatpan.ts/deployment";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting } from "@sweatpan.ts/hosting";
import { createToolAdmission } from "@sweatpan.ts/tools";
import { createSqliteJournalStore, v8Serializer } from "@sweatpan.ts/storage-sqlite";
import {
  createSqliteDatabaseRig,
  createHostedRecovery,
  createProtocolRig,
  createLatch,
} from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

// This application owns its catalog, sweep checkpoint, clock/backoff and pinned recipe.
// It has one designated sweep owner, processes one entry per invocation and wraps in ID order.
const PROGRAM = "sweep:sample-approval:v1";
type Report = ActivationReconciliation<string, string>;
type Visit = { id: string } & (
  | { state: "unadmitted" | "idle" | "backoff" }
  | { state: "failed"; error: unknown }
  | { state: "driven"; report: Report }
);
type Tick = Visit | { state: "wrapped" };

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task.result;
  }
  function application() {
    const rig = createSqliteDatabaseRig();
    onTestFinished(() => rig.close());
    const peer = createProtocolRig();
    const acquisitions = new Map<string, number>();
    const unavailable = new Set<string>();
    const observations: Visit[] = [];
    let loseCheckpointFor: string | undefined;
    let cleanup: (() => Operation<void, Y>) | undefined;
    function assemble() {
      const db = rig.database;
      db.exec(`
        CREATE TABLE IF NOT EXISTS consumer_catalog (id TEXT PRIMARY KEY, program TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS consumer_sweep (singleton INTEGER PRIMARY KEY CHECK(singleton=1), after_id TEXT);
        INSERT OR IGNORE INTO consumer_sweep VALUES (1, NULL);
        CREATE TABLE IF NOT EXISTS consumer_backoff (id TEXT PRIMARY KEY, token TEXT NOT NULL, until_tick INTEGER NOT NULL);
      `);
      function store(id: string, program = PROGRAM) {
        return createSqliteJournalStore<string, string, string, string, unknown, Y>({
          database: db,
          id,
          program,
          equals: isDeepStrictEqual,
          serialization: {
            *resolve() {
              return v8Serializer;
            },
          },
        });
      }
      function enroll(id: string, program = PROGRAM) {
        db.prepare("INSERT OR IGNORE INTO consumer_catalog VALUES (?, ?)").run(id, program);
        if (
          db.prepare("SELECT program FROM consumer_catalog WHERE id=?").get(id)?.program !== program
        ) {
          throw new Error("Catalog binding is immutable");
        }
      }
      function* submit(id: string, input: string) {
        enroll(id); // Membership is persisted BEFORE admission; no wakeup callback follows.
        const admission = createToolAdmission(
          runtime,
          `admit:${id}`,
          { id: PROGRAM, context: z.string().trim().min(1) },
          store(id).open(),
        );
        return yield* admission.operations.admit(input);
      }
      function* tick(now: number, deadline = new AbortController().signal): Operation<Tick, Y> {
        if (!Number.isSafeInteger(now) || now < 0) {
          throw new Error("Invalid scheduler tick");
        }
        const after = db
          .prepare("SELECT after_id FROM consumer_sweep WHERE singleton=1")
          .get()!.after_id;
        const row = db
          .prepare(
            "SELECT id, program FROM consumer_catalog WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT 1",
          )
          .get(after as string | null, after as string | null);
        if (!row) {
          db.prepare("UPDATE consumer_sweep SET after_id=NULL WHERE singleton=1").run();
          return { state: "wrapped" };
        }
        const id = row.id as string;
        let observedToken: string | undefined;
        const visit: Visit = yield* runtime.composition.catchError(
          function* (): Operation<Visit, Y> {
            const bound = store(id, row.program as string);
            const journal = bound.open();
            const snapshot = yield* journal.read(); // Also checks the persisted program binding.
            if (snapshot.status === "running" && !snapshot.admission) {
              return { id, state: "unadmitted" };
            }
            const intents = createActivationIntents(
              runtime.composition,
              `intents:${id}`,
              bound.activations,
            );
            const pending = yield* intents.operations.read();
            if (!pending) {
              return { id, state: "idle" };
            }
            observedToken = pending.token;
            const backoff = db
              .prepare("SELECT token, until_tick FROM consumer_backoff WHERE id=?")
              .get(id);
            if (backoff?.token === pending.token && Number(backoff.until_tick) > now) {
              return { id, state: "backoff" };
            }
            const report = yield* runtime.withSignal(deadline, function* () {
              let settled = 0;
              const recovery = createHostedRecovery(runtime, {
                name: `sweep-recovery:${id}`,
                program: row.program as string,
                matches: isDeepStrictEqual,
                *acquire() {
                  // Resolve only when evaluation is needed. Terminal roots do not require code.
                  if (row.program !== PROGRAM || unavailable.has(id)) {
                    throw new Error("Pinned executable unavailable");
                  }
                  const input = z.string().parse(snapshot.admission?.input);
                  acquisitions.set(id, (acquisitions.get(id) ?? 0) + 1);
                  return createScopedGuest(function* () {
                    const answer: unknown = yield `sample:${input}`;
                    const approved: unknown = yield "approval";
                    return `${String(answer)}:${String(approved)}`;
                  });
                },
              });
              const host = createHosting(runtime.composition, {
                name: `sweep-host:${id}`,
                journal,
                recovery: recovery.operations,
                attempts: journal.attempts,
                interactions: journal.interactions,
                *handle(request: string): Operation<Outcome<string, string>, Y> {
                  if (cleanup) {
                    yield* runtime.composition.ensure(cleanup);
                  }
                  const response = yield* runtime.fromPromise((signal) =>
                    peer.send({ id, token: request }, signal),
                  );
                  return { ok: true, value: response.body };
                },
              });
              yield* host.around({
                *continuation() {
                  return settled >= 2
                    ? { action: "yield", reason: "sweep budget" }
                    : { action: "continue" };
                },
                *deliveryMode([request]) {
                  return request === "approval" ? "wait" : "execute";
                },
              });
              yield* host.attempts.around({
                *settle(args, next) {
                  const accepted = yield* next(...args);
                  settled++;
                  return accepted;
                },
              });
              const reconciler = createActivationReconciler(runtime.composition, `sweep:${id}`, {
                intents,
                run: host.operations.run,
              });
              return yield* reconciler.operations.reconcile();
            });
            return { id, state: "driven", report };
          },
          function* (error) {
            return { id, state: "failed" as const, error };
          },
        );
        // Errors are uncertain observations: do not infer whether intent deletion committed.
        // Backoff references only the PRE-drive token; a newer token always bypasses it.
        if (
          observedToken &&
          (visit.state === "failed" ||
            (visit.state === "driven" &&
              visit.report.state === "driven" &&
              ["occupied", "invalidated"].includes(visit.report.result.state)))
        ) {
          db.prepare(
            "INSERT INTO consumer_backoff VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET token=excluded.token, until_tick=excluded.until_tick",
          ).run(id, observedToken, now + 10);
        }
        if (loseCheckpointFor === id) {
          loseCheckpointFor = undefined;
          throw new Error("Process stopped before checkpoint and observation");
        }
        // All skip, failure, backoff and successful outcomes advance this single owner's cursor.
        db.prepare("UPDATE consumer_sweep SET after_id=? WHERE singleton=1").run(id);
        observations.push(visit); // Advisory only; journal status is authoritative.
        return visit;
      }
      return { store, enroll, submit, tick };
    }
    return {
      rig,
      peer,
      acquisitions,
      unavailable,
      observations,
      assemble,
      set loseCheckpointFor(id: string | undefined) {
        loseCheckpointFor = id;
      },
      set cleanup(value: (() => Operation<void, Y>) | undefined) {
        cleanup = value;
      },
    };
  }

  it(`${runtime.name}: persisted sweep traversal discovers admitted roots after restart and recovers lost observations`, async () => {
    const scenario = application();
    let app = scenario.assemble();
    app.enroll("a");
    await start(app.store("a").activations.request); // Intent is NOT admission authority.
    scenario.rig.reopen();
    app = scenario.assemble();
    expect(await start(() => app.tick(0))).toEqual({ id: "a", state: "unadmitted" });
    expect(scenario.acquisitions.get("a")).toBeUndefined();
    expect(await start(app.store("a").activations.read)).toBeDefined();
    await start(() => app.submit("b", "  research  "));
    await start(() => app.submit("c", "other"));
    expect(() => app.enroll("b", "changed-program")).toThrow("immutable");
    scenario.rig.reopen();
    app = scenario.assemble();
    const b = start(() => app.tick(0));
    await scenario.peer.waitForRequests(1);
    expect(scenario.peer.requests[0]).toEqual({ id: "b", token: "sample:research" });
    scenario.peer.reply("b", { status: 200, body: "finding" });
    expect((await b).state).toBe("driven");
    // Restart between one-entry pages: the persisted cursor reaches c, not a again.
    scenario.rig.reopen();
    app = scenario.assemble();
    const c = start(() => app.tick(0));
    await scenario.peer.waitForRequests(2);
    expect(scenario.peer.requests[1]!.id).toBe("c");
    scenario.peer.reply("c", { status: 200, body: "other finding" });
    await c;
    async function visit(id: string, now = 0): Promise<Visit> {
      for (let count = 0; count < 4; count++) {
        const result = await start(() => app.tick(now));
        if ("id" in result && result.id === id) {
          return result;
        }
      }
      throw new Error("Sweep failed to reach root");
    }
    expect(await visit("a")).toEqual({ id: "a", state: "unadmitted" });
    const stable = await visit("b");
    expect(
      stable.state === "driven" && stable.report.state === "driven" && stable.report.acknowledged,
    ).toBe(true);
    const journal = app.store("b").open();
    const snapshot = await start(() => journal.read());
    if (snapshot.interaction?.state !== "waiting") {
      throw new Error("Expected approval");
    }
    const grant = snapshot.interaction.grant;
    await start(() => journal.interactions.answer(grant, { ok: true, value: "yes" }));
    scenario.rig.reopen();
    app = scenario.assemble(); // No notification or prompt wakeup exists.
    const completed = await visit("b");
    expect(
      completed.state === "driven" &&
        completed.report.state === "driven" &&
        completed.report.result,
    ).toEqual({ state: "completed", value: "finding:yes" });
    scenario.unavailable.add("b");
    scenario.loseCheckpointFor = "b";
    await expect(visit("b")).rejects.toThrow("Process stopped before checkpoint");
    scenario.rig.reopen();
    app = scenario.assemble();
    // Final token was cleared before the lost telemetry/checkpoint. Journal still proves completion.
    expect(await visit("b")).toEqual({ id: "b", state: "idle" });
    expect((await start(() => app.store("b").open().read())).status).toBe("completed");
    expect(scenario.peer.requests.filter((entry) => entry.id === "b")).toHaveLength(1);
    await expect(start(() => app.store("b", "wrong").open().read())).rejects.toThrow(
      "Journal program mismatch",
    );
  });

  it(`${runtime.name}: cooperative deadline failure advances traversal, and new intent bypasses old-token backoff`, async () => {
    const scenario = application();
    let app = scenario.assemble();
    await start(() => app.submit("a", "stalled"));
    await start(() => app.submit("b", "healthy"));
    const cleaning = createLatch<void>();
    const release = createLatch<void>();
    onTestFinished(() => release.resolve());
    scenario.cleanup = function* () {
      cleaning.resolve();
      yield* runtime.fromPromise(() => release.promise);
    };
    const deadline = new AbortController();
    const stalled = start(() => app.tick(0, deadline.signal));
    let finished = false;
    void stalled.then(() => {
      finished = true;
    });
    await scenario.peer.waitForRequests(1);
    deadline.abort(new Error("Provider deadline"));
    await cleaning.promise;
    expect(finished).toBe(false);
    release.resolve();
    expect((await stalled).state).toBe("failed");
    scenario.cleanup = undefined;
    scenario.rig.reopen();
    app = scenario.assemble();
    const healthy = start(() => app.tick(0));
    await scenario.peer.waitForRequests(2);
    expect(scenario.peer.requests[1]!.id).toBe("b");
    scenario.peer.reply("b", { status: 200, body: "ok" });
    await healthy;
    async function visitA(now: number): Promise<Visit> {
      for (let count = 0; count < 3; count++) {
        const result = await start(() => app.tick(now));
        if ("id" in result && result.id === "a") {
          return result;
        }
      }
      throw new Error("Missing a");
    }
    const occupied = await visitA(0);
    expect(
      occupied.state === "driven" &&
        occupied.report.state === "driven" &&
        occupied.report.result.state,
    ).toBe("occupied");
    const visits = scenario.acquisitions.get("a");
    expect(await visitA(5)).toEqual({ id: "a", state: "backoff" });
    expect(scenario.acquisitions.get("a")).toBe(visits);
    await start(app.store("a").activations.request);
    const reconsidered = await visitA(5);
    expect(
      reconsidered.state === "driven" &&
        reconsidered.report.state === "driven" &&
        reconsidered.report.result.state,
    ).toBe("occupied");
    expect(scenario.acquisitions.get("a")).toBeGreaterThan(visits!);
    const journal = app.store("a").open();
    const snapshot = await start(() => journal.read());
    if (snapshot.status !== "running" || !snapshot.pending) {
      throw new Error("Missing occupied request");
    }
    await start(() => journal.cancellation.request(snapshot.pending!.id, "operator stop"));
    const cancelled = await visitA(5);
    expect(
      cancelled.state === "driven" &&
        cancelled.report.state === "driven" &&
        cancelled.report.result.state,
    ).toBe("cancelled");
    expect(scenario.peer.requests.filter((entry) => entry.id === "a")).toHaveLength(1);
  });
});
