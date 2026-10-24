import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { call, createContext, createQueue, resource, run, sleep, spawn, suspend } from "effection";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { inProcess } from "@sweatpants/agent-host/server";
import {
  DurableProgramCancellation,
  exactProgramKey,
  type AttachProgramRequest,
} from "@sweatpants/durable-execution";
import { digestCanonicalJson, type Json } from "@sweatpants/foundation";
import {
  createWorkflowProgramDriver,
  openProgramAttachment,
  ProgramEffectRuntimeContext,
  type ProgramEffectRuntime,
  type RuntimeRecordBoundary,
} from "@sweatpants/journal-authority";
import { makePlugin } from "@sweatpants/react-chat";
import { withTestScenario } from "@sweatpants/test-rig";
import { z } from "zod";
import { createApplication } from "../../fixtures/application.ts";
import { useClient, waitForSnapshot } from "../../support/client.ts";

const evidence = resolve(`../.artifacts/primitive-journal/loop-6/resume-1/run-${Date.now()}`);
mkdirSync(evidence, { recursive: true });
const owner = createContext<string>("acceptance:native-work-owner");

describe("native Work public authoring", () => {
  for (const mode of ["complete", "fail", "cancel"] as const) {
    it(`releases native resources and children before ${mode} is observed`, async () => {
      const trace: string[] = [];
      const reasons: (string | undefined)[] = [];
      let activations = 0;
      const choices = createQueue<void, never>();
      const parked = createQueue<void, never>();
      const tool = createDurableTool("native_lifetime")
        .description("Observe native scope ownership and recorded cancellation cleanup")
        .identity({ version: "1", digest: "6".repeat(64) })
        .parameters(z.object({ label: z.string() }))
        .output(z.object({ label: z.string() }))
        .elicits({ choose: { response: z.object({ accepted: z.boolean() }) } })
        .execute(function* ({ label }, ctx) {
          const activation = `${label}:${++activations}`;
          trace.push(`${activation}:start`);
          expect(yield* owner.get()).toBeUndefined();
          yield* owner.set(label);
          yield* resource(function* (provide) {
            trace.push(`${activation}:acquire`);
            try {
              yield* provide(undefined);
            } finally {
              yield* sleep(0);
              trace.push(`${activation}:release`);
            }
          });
          yield* spawn(function* () {
            trace.push(`${activation}:child`);
            try {
              yield* suspend();
            } finally {
              yield* sleep(0);
              trace.push(`${activation}:child-release`);
            }
          });
          try {
            yield* ctx.elicit("choose", { message: label });
            expect(yield* owner.expect()).toBe(label);
            if (mode === "fail") {
              throw new Error("authored failure");
            }
            return { label };
          } catch (error) {
            if (error instanceof DurableProgramCancellation) {
              trace.push(`${label}:cancel:${error.reason}`);
              reasons.push(error.reason);
            }
            throw error;
          } finally {
            yield* ctx.record(
              { key: "native-cleanup", retrySafety: { mode: "repeatable" } },
              function* () {
                yield* sleep(0);
                trace.push(`${label}:recorded-cleanup`);
                return { cleaned: label };
              },
            );
            trace.push(`${label}:cleanup-accepted`);
          }
        });
      const plugin = makePlugin(tool)
        .onElicit({
          choose: function* () {
            parked.add(undefined);
            yield* choices.next();
            return { action: "accept", content: { accepted: true } };
          },
        })
        .build();
      let application: ReturnType<typeof createApplication>;
      await withTestScenario(
        {
          binding: "http",
          createApplication: (context) => {
            application = createApplication(context, { tools: [tool], execution: inProcess() });
            return application;
          },
        },
        function* (rig) {
          const client = yield* useClient(rig, { threadId: `native-${mode}`, plugins: [plugin] });
          const sending = yield* spawn(() => call(() => client.sendMessage("Run native work")));
          const request = yield* rig.model.request();
          yield* request.respond.toolCalls([
            { id: "native-call", name: tool.name, arguments: { label: mode } },
          ]);
          yield* parked.next();
          expect(trace.some((entry) => entry.endsWith(":child"))).toBe(true);
          if (mode === "cancel") {
            yield* call(() => client.stop());
            yield* waitForSnapshot(client, (state) => state.authority?.state === "idle");
            expect(reasons).toEqual([undefined]); // Amendment 1: baseline settlement omits reason.
          } else {
            choices.add(undefined);
            if (mode === "complete") {
              const final = yield* rig.model.request();
              for (let activation = 1; activation <= activations; activation++) {
                expect(trace).toContain(`${mode}:${activation}:release`);
                expect(trace).toContain(`${mode}:${activation}:child-release`);
              }
              expect(trace).toContain(`${mode}:cleanup-accepted`);
              expect(JSON.stringify(final.body.input)).toContain("native-call");
              yield* final.respond.text("Done");
              yield* waitForSnapshot(client, (state) => state.status === "ready");
            } else {
              yield* waitForSnapshot(client, (state) => state.status === "error");
            }
          }
          yield* sending;
          trace.push("observed-terminal");
          expect(trace.filter((entry) => entry === `${mode}:recorded-cleanup`)).toHaveLength(1);
          expect(trace).toContain(`${mode}:cleanup-accepted`);
          for (let activation = 1; activation <= activations; activation++) {
            for (const released of ["release", "child-release"]) {
              const entry = `${mode}:${activation}:${released}`;
              expect(trace.filter((observed) => observed === entry)).toHaveLength(1);
              expect(trace.indexOf(entry)).toBeLessThan(trace.indexOf("observed-terminal"));
            }
          }
          const storage = yield* call(() => application.inspect());
          const journal = yield* storage.programDriverJournalStore.withJournal(
            `native-${mode}`,
            (opened) => opened.readJournal(`native-${mode}`),
          );
          const cleanup = journal.filter(
            (entry) =>
              entry.payload.type === "PullRequested" &&
              entry.payload.descriptor.kind === "record" &&
              entry.payload.descriptor.key === "native-cleanup",
          );
          expect(cleanup).toHaveLength(1);
          const cleanupPayload = cleanup[0].payload;
          if (cleanupPayload.type !== "PullRequested") {
            throw new Error("Expected cleanup pull");
          }
          const attempts = journal.filter(
            (entry) =>
              entry.payload.type === "AttemptStarted" &&
              entry.payload.pullId === cleanupPayload.pullId,
          );
          const resolutions = journal.filter(
            (entry) =>
              entry.payload.type === "PullResolved" &&
              entry.payload.pullId === cleanupPayload.pullId,
          );
          expect(attempts).toHaveLength(1);
          expect(resolutions).toHaveLength(1);
          expect(resolutions[0].payload).toMatchObject({
            outcome: { status: "ok", value: { cleaned: mode } },
          });
          const terminals = journal.filter((entry) => entry.payload.type === "TaskClosed");
          expect(terminals).toHaveLength(2);
          expect(
            terminals.every((entry) => BigInt(entry.offset) > BigInt(resolutions[0].offset)),
          ).toBe(true);
          if (mode === "cancel") {
            expect(
              journal
                .filter((entry) => entry.payload.type === "CancellationRequested")
                .map((entry) => entry.payload),
            ).toMatchObject([{ reason: "user" }, { reason: "user" }]);
          }
          writeFileSync(
            resolve(evidence, `journal-${mode}.json`),
            JSON.stringify(journal, null, 2),
          );
          if (mode === "cancel") {
            trace.push("successor-start");
            const successor = yield* spawn(() =>
              call(() => client.sendMessage("Continue after cancellation")),
            );
            const request = yield* rig.model.request();
            yield* request.respond.text("Successor done");
            yield* successor;
            yield* waitForSnapshot(client, (state) => state.status === "ready");
            expect(trace.indexOf("cancel:cleanup-accepted")).toBeLessThan(
              trace.indexOf("successor-start"),
            );
          }
          writeFileSync(
            resolve(evidence, `lifecycle-${mode}.json`),
            JSON.stringify(trace, null, 2),
          );
        },
      );
    });
  }
});

it("isolates native capabilities in sibling public clients while both tools are live", async () => {
  const entered = createQueue<string, never>();
  const releases = new Map([
    ["A", createQueue<void, never>()],
    ["B", createQueue<void, never>()],
  ]);
  const observed: string[] = [];
  const tool = createDurableTool("native_sibling")
    .description("Native sibling scope")
    .identity({ version: "1", digest: "7".repeat(64) })
    .parameters(z.object({ label: z.string() }))
    .output(z.object({ label: z.string() }))
    .execute(function* ({ label }) {
      expect(yield* owner.get()).toBeUndefined();
      yield* owner.set(label);
      entered.add(label);
      yield* releases.get(label)!.next();
      observed.push(yield* owner.expect());
      return { label };
    });
  await withTestScenario(
    {
      binding: "http",
      createApplication: (context) =>
        createApplication(context, { tools: [tool], execution: inProcess() }),
    },
    function* (rig) {
      const a = yield* useClient(rig, { threadId: "native-sibling-A" });
      const b = yield* useClient(rig, { threadId: "native-sibling-B" });
      const sendA = yield* spawn(() => call(() => a.sendMessage("A")));
      const requestA = yield* rig.model.request();
      yield* requestA.respond.toolCalls([
        { id: "A-call", name: tool.name, arguments: { label: "A" } },
      ]);
      expect((yield* entered.next()).value).toBe("A");
      const sendB = yield* spawn(() => call(() => b.sendMessage("B")));
      const requestB = yield* rig.model.request();
      yield* requestB.respond.toolCalls([
        { id: "B-call", name: tool.name, arguments: { label: "B" } },
      ]);
      expect((yield* entered.next()).value).toBe("B");
      releases.get("B")!.add(undefined);
      const finalB = yield* rig.model.request();
      expect(JSON.stringify(finalB.body.input)).toContain("B-call");
      expect(JSON.stringify(finalB.body.input)).not.toContain("A-call");
      yield* finalB.respond.text("B done");
      yield* sendB;
      releases.get("A")!.add(undefined);
      const finalA = yield* rig.model.request();
      expect(JSON.stringify(finalA.body.input)).toContain("A-call");
      expect(JSON.stringify(finalA.body.input)).not.toContain("B-call");
      yield* finalA.respond.text("A done");
      yield* sendA;
      expect(observed).toEqual(["B", "A"]);
      expect(yield* owner.get()).toBeUndefined();
    },
  );
});

// Lower-level public attachment/driver contract evidence; these are not the HTTP anchor.
const attach: AttachProgramRequest = {
  sessionId: "native-contract",
  taskId: "root",
  executionEpoch: 1,
  program: { id: "native_contract", version: "1", digest: "8".repeat(64) },
  input: {},
  route: { driverKind: "workflow" },
};
const descriptor = {
  kind: "record" as const,
  key: "first",
  retrySafety: { mode: "repeatable" as const },
};
const boundary: RuntimeRecordBoundary<null> = {
  serializable: { type: "operation", descriptor },
  *execute() {
    return null;
  },
};
function receipt(outcome: Json, index: number) {
  return {
    sessionId: attach.sessionId,
    taskId: attach.taskId,
    pullId: `pull-${index}`,
    resolutionOffset: String(index + 1),
    status: "accepted" as const,
    outcomeDigest: digestCanonicalJson(outcome),
  };
}

for (const first of ["record", "emission"] as const) {
  for (const second of ["record", "emission"] as const) {
    it(`rejects concurrent ${first}/${second} and clears the guard after settlement`, async () => {
      await run(function* () {
        const errors = createQueue<unknown, never>();
        const handle = yield* openProgramAttachment(attach, function* () {
          const runtime = yield* ProgramEffectRuntimeContext.expect();
          const pending = yield* spawn(() =>
            first === "record"
              ? runtime.perform(boundary)
              : runtime.requestEmission({ eventType: "first", payload: null }),
          );
          yield* sleep(0);
          try {
            if (second === "record") {
              yield* runtime.perform(boundary);
            } else {
              yield* runtime.requestEmission({ eventType: "second", payload: null });
            }
          } catch (error) {
            errors.add(error);
          }
          yield* pending;
          return yield* runtime.requestEmission({ eventType: "after", payload: null });
        });
        expect(yield* handle.exchange({ type: "start", input: {} })).toMatchObject({
          type: first === "record" ? "record-proposed" : "emission-proposed",
          actionIndex: 0,
        });
        expect((yield* errors.next()).value).toMatchObject({
          message: "concurrent_kernel_request",
        });
        const outcome = { status: "ok" as const, value: null };
        const next =
          first === "record"
            ? yield* handle.exchange({
                type: "resume-record",
                actionIndex: 0,
                outcome,
                receipt: receipt(outcome, 0),
                replayed: true,
              })
            : yield* handle.exchange({ type: "ack-emission", actionIndex: 0, offset: "1" });
        expect(next).toMatchObject({
          type: "emission-proposed",
          actionIndex: 1,
          descriptor: { eventType: "after" },
        });
        expect(
          yield* handle.exchange({ type: "ack-emission", actionIndex: 1, offset: "2" }),
        ).toEqual({ type: "completed", actionIndex: 2, value: "2" });
        yield* handle.close("completed");
      });
    });
  }
}

it("preserves explicit driver cancellation reason through native cleanup and releases before terminal", async () => {
  const trace: string[] = [];
  let cancellation: unknown;
  const tool = createDurableTool("native_contract")
    .description("Explicit cancellation")
    .identity({ version: "1", digest: "8".repeat(64) })
    .parameters(z.object({}))
    .output(z.null())
    .execute(function* (_, ctx) {
      yield* resource(function* (provide) {
        try {
          yield* provide(undefined);
        } finally {
          yield* sleep(0);
          trace.push("release");
        }
      });
      yield* spawn(function* () {
        try {
          yield* suspend();
        } finally {
          yield* sleep(0);
          trace.push("child-release");
        }
      });
      try {
        yield* ctx.record({ key: "first" }, function* () {
          return null;
        });
      } catch (error) {
        cancellation = error;
        throw error;
      } finally {
        yield* ctx.record({ key: "cleanup" }, function* () {
          trace.push("cleanup-attempt");
          return null;
        });
        expect(cancellation).toBeInstanceOf(DurableProgramCancellation);
        expect(cancellation).toMatchObject({ reason: "withdrawn" });
        trace.push("cleanup-accepted");
      }
      return null;
    });
  await run(function* () {
    const driver = createWorkflowProgramDriver(new Map([[exactProgramKey(attach.program), tool]]));
    const active = yield* driver.attach(attach);
    expect(yield* driver.step(active, { type: "start", input: {} })).toMatchObject({
      type: "operation",
      actionIndex: 0,
    });
    expect(yield* driver.step(active, { type: "cancel", reason: "withdrawn" })).toMatchObject({
      type: "operation",
      actionIndex: 0,
      descriptor: { key: "cleanup" },
    });
    const outcome = { status: "ok" as const, value: null };
    expect(
      yield* driver.step(active, {
        type: "authorize",
        actionIndex: 0,
        pullId: "pull-0",
        attemptId: "attempt-0",
        resolutionCapability: "contract",
        descriptor: { kind: "record", key: "cleanup", retrySafety: { mode: "repeatable" } },
      }),
    ).toMatchObject({ authorizedOutcome: outcome });
    expect(trace).toEqual(["cleanup-attempt"]);
    expect(
      yield* driver.step(active, {
        type: "resume",
        actionIndex: 0,
        outcome,
        receipt: receipt(outcome, 0),
        replayed: false,
      }),
    ).toMatchObject({ type: "failed", error: { code: "program_cancelled" } });
    expect(trace.slice(0, 2)).toEqual(["cleanup-attempt", "cleanup-accepted"]);
    expect(trace.slice(2).toSorted()).toEqual(["child-release", "release"]);
    yield* driver.shutdown(active, "cancelled");
    writeFileSync(
      resolve(evidence, "explicit-cancel.json"),
      JSON.stringify({
        trace,
        reason: cancellation instanceof DurableProgramCancellation ? cancellation.reason : null,
      }),
    );
  });
});

it("authorizes without delivery and rejects retained runtime use across a successor", async () => {
  let retained: ProgramEffectRuntime | undefined;
  const trace: string[] = [];
  await run(function* () {
    const previous = yield* openProgramAttachment(attach, function* () {
      retained = yield* ProgramEffectRuntimeContext.expect();
      const result = yield* retained.perform({
        serializable: { type: "operation", descriptor },
        *execute() {
          trace.push("attempt");
          return null;
        },
      });
      trace.push("delivered");
      return result.status;
    });
    yield* previous.exchange({ type: "start", input: {} });
    const outcome = { status: "ok" as const, value: null };
    expect(
      yield* previous.exchange({
        type: "authorize-record",
        actionIndex: 0,
        pullId: "pull-0",
        attemptId: "attempt-0",
        descriptor,
      }),
    ).toMatchObject({ type: "record-attempt-completed", outcome });
    yield* sleep(0);
    expect(trace).toEqual(["attempt"]);
    expect(
      yield* previous.exchange({
        type: "resume-record",
        actionIndex: 0,
        outcome,
        receipt: receipt(outcome, 0),
        replayed: false,
      }),
    ).toMatchObject({ type: "completed", value: "ok" });
    expect(trace).toEqual(["attempt", "delivered"]);
    yield* previous.close("completed");
    const successor = yield* openProgramAttachment({ ...attach, executionEpoch: 2 }, function* () {
      const runtime = yield* ProgramEffectRuntimeContext.expect();
      expect(runtime).not.toBe(retained);
      yield* runtime.perform(boundary);
      return null;
    });
    expect(yield* successor.exchange({ type: "start", input: {} })).toMatchObject({
      type: "record-proposed",
      actionIndex: 0,
    });
    for (const operation of [
      () => retained!.perform(boundary),
      () => retained!.requestEmission({ eventType: "stale", payload: null }),
      () => previous.exchange({ type: "start", input: {} }),
    ]) {
      let error: unknown;
      try {
        yield* operation();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/execution_closed|disposed/);
    }
    expect(
      yield* successor.exchange({
        type: "resume-record",
        actionIndex: 0,
        outcome,
        receipt: receipt(outcome, 0),
        replayed: true,
      }),
    ).toMatchObject({ type: "completed", actionIndex: 1 });
    expect(trace).toEqual(["attempt", "delivered"]);
    yield* successor.close("completed");
  });
});

it("physically closes parked native work with yielding release and no logical cancellation or new boundary", async () => {
  await run(function* () {
    const trace: string[] = [];
    let retained: ProgramEffectRuntime | undefined;
    const handle = yield* openProgramAttachment(attach, function* () {
      retained = yield* ProgramEffectRuntimeContext.expect();
      yield* resource(function* (provide) {
        try {
          yield* provide(undefined);
        } finally {
          yield* sleep(0);
          trace.push("release");
        }
      });
      try {
        yield* retained.perform(boundary);
      } catch (error) {
        expect(error).not.toBeInstanceOf(DurableProgramCancellation);
      } finally {
        yield* sleep(0);
        try {
          yield* retained.perform(boundary);
        } catch (error) {
          trace.push("cleanup-rejected");
          expect(error).toMatchObject({ code: "stale_program_capability" });
        }
      }
      return null;
    });
    expect(yield* handle.exchange({ type: "start", input: {} })).toMatchObject({
      type: "record-proposed",
      actionIndex: 0,
    });
    yield* handle.close("transport_lost");
    expect(trace).toEqual(["cleanup-rejected", "release"]);
    let error: unknown;
    try {
      yield* retained!.requestEmission({ eventType: "stale", payload: null });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ message: "execution_closed" });
    yield* handle.close("transport_lost");
    expect(trace).toEqual(["cleanup-rejected", "release"]);
  });
});
