import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { createSchemeKernel } from "@sweatpan.ts/codemode-runtime-scheme";
import { createRecovery, createCheckpointMiddleware } from "@sweatpan.ts/durable";
import { createHosting } from "@sweatpan.ts/hosting";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";
import { source, identity, program, machineLoader } from "../../examples/scheme-workflow.mjs";
const reply = z.object({
  action: z.literal("accept"),
  content: z.object({ approved: z.boolean() }),
});
const accepted = { action: "accept", content: { approved: true } };
const requestSchema = z.tuple([z.literal("elicit"), z.enum(["approval", "cleanup"]), z.string()]);
type Request = { key: "approval" | "cleanup"; message: string };
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function kernel() {
    return createSchemeKernel(runtime, {
      identity,
      loadMachine: machineLoader,
      decodeRequest(boundary): Request {
        const [, key, message] = requestSchema.parse(boundary.value);
        return { key, message };
      },
      decodeResult: (value) => z.string().parse(value),
    });
  }
  it(`${runtime.name}: compiled use workflow survives SQLite reopen at approval and cleanup`, async () => {
    const store = createSqliteJournalRig<string, Request, unknown, string, unknown, Y>({
      program,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    let starts = 0,
      restores = 0;
    async function run() {
      return runtime.start(function* () {
        const recipe = yield* kernel().prepare(source, {
          title: "Review this draft",
          recipient: "demo",
          metadata: null,
        });
        const recovery = createRecovery(runtime.composition, {
          name: "scheme-recovery",
          program,
          matches: isDeepStrictEqual,
          *acquire() {
            starts++;
            return yield* recipe.acquire();
          },
        });
        const adapter = {
          ...recipe.checkpoints,
          *restore(state: unknown) {
            restores++;
            return yield* recipe.checkpoints.restore(state);
          },
        };
        yield* recovery.around(
          createCheckpointMiddleware({
            execution: recovery.execution,
            program,
            matches: isDeepStrictEqual,
            adapter,
          }),
        );
        const journal = store.open();
        const host = createHosting(runtime.composition, {
          name: "scheme-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          *handle() {
            throw new Error("Participant input required");
          },
        });
        yield* host.around({
          *deliveryMode() {
            return "wait";
          },
        });
        return yield* host.operations.run();
      }).result;
    }
    async function answer(key: Request["key"]) {
      return runtime.start(function* () {
        const journal = store.open();
        const state = yield* journal.read();
        if (state.status !== "running" || state.interaction?.state !== "waiting") {
          throw new Error("Expected participant wait");
        }
        expect(yield* journal.interactions.request(state.interaction.grant)).toMatchObject({ key });
        return yield* journal.interactions.answer(state.interaction.grant, {
          ok: true,
          value: reply.parse(accepted),
        });
      }).result;
    }
    await run();
    store.reopen();
    await answer("approval");
    await run();
    store.reopen();
    await answer("cleanup");
    expect(await run()).toEqual({ state: "completed", value: "Draft approved" });
    expect(restores).toBeGreaterThan(0);
    const before = { starts, restores };
    store.reopen();
    expect(await run()).toEqual({ state: "completed", value: "Draft approved" });
    expect({ starts, restores }).toEqual(before);
  });
  it(`${runtime.name}: rejected approval drains cleanup before surfacing failure`, async () => {
    await runtime.start(function* () {
      const recipe = yield* kernel().prepare(source, {
        title: "Draft",
        recipient: "demo",
        metadata: null,
      });
      const guest = yield* recipe.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      yield* guest.start();
      expect(yield* guest.resume({ ok: false, error: "Approval unavailable" })).toMatchObject({
        kind: "suspended",
        request: { key: "cleanup" },
        scope: { phase: "cleanup" },
      });
      const saved = yield* recipe.checkpoints.capture(guest);
      yield* guest.close();
      const restored = yield* recipe.checkpoints.restore(saved);
      yield* runtime.composition.ensure(() => restored.guest.close());
      let failure: unknown;
      try {
        yield* restored.guest.resume({ ok: true, value: accepted });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ name: "SchemeFailure", value: "Approval unavailable" });
    }).result;
  });
  it(`${runtime.name}: stopping during lazy machine loading disposes the late machine`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const loading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let closed!: () => void;
    const disposed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const task = runtime.start(function* () {
      const recipe = yield* createSchemeKernel(runtime, {
        identity,
        async loadMachine() {
          entered();
          await gate;
          const machine = await machineLoader();
          return {
            ...machine,
            close() {
              machine.close();
              closed();
            },
          };
        },
        decodeRequest: (value) => value,
        decodeResult: (value) => value,
      }).prepare(source, { title: "Draft", recipient: "demo", metadata: null });
      const guest = yield* recipe.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      return yield* guest.start();
    });
    void task.result.catch(() => undefined);
    onTestFinished(async () => {
      release();
      await task.cancel();
    });
    await loading;
    await task.cancel();
    release();
    await disposed;
  });
  for (const cancelAt of ["body", "cleanup"] as const) {
    it(`${runtime.name}: Scheme ${cancelAt} cancellation retains cleanup across detached restore`, async () => {
      await runtime.start(function* () {
        const recipe = yield* kernel().prepare(source, {
          title: "Draft",
          recipient: "demo",
          metadata: null,
        });
        const guest = yield* recipe.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        expect(yield* guest.start()).toMatchObject({
          kind: "suspended",
          request: { key: "approval" },
          scope: { phase: "body" },
        });
        if (cancelAt === "cleanup") {
          yield* guest.resume({ ok: true, value: accepted });
        }
        if (!guest.cancel) {
          throw new Error("Missing cancellation");
        }
        const cleanup = yield* guest.cancel("stop");
        expect(cleanup).toMatchObject({
          kind: "suspended",
          request: { key: "cleanup" },
          scope: { phase: "cleanup" },
        });
        expect(yield* guest.cancel("other")).toEqual(cleanup);
        const snapshot = yield* recipe.checkpoints.capture(guest);
        yield* guest.close();
        const fresh = yield* kernel().prepare(source, {
          title: "Draft",
          recipient: "demo",
          metadata: null,
        });
        const restored = yield* fresh.checkpoints.restore(snapshot);
        yield* runtime.composition.ensure(() => restored.guest.close());
        expect(restored.turn).toEqual(cleanup);
        expect(yield* restored.guest.resume({ ok: true, value: accepted })).toMatchObject({
          kind: "cancelled",
          reason: "stop",
        });
        const changed = yield* kernel().prepare(source + "\n;changed", null);
        let rejected = false;
        try {
          yield* changed.checkpoints.restore(snapshot);
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      }).result;
    });
  }
});
