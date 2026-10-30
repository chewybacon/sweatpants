import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest, type EffectDefinition } from "@sweatpan.ts/core";
import { createRecovery, type OwnedChild, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import { defineTool, type ToolDefinition } from "@sweatpan.ts/tools";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSqliteJournalRig, readJournal } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

// Provisional authored sugar and routing remain local to this executable tracer.
const group = defineEffect({
  key: "tracer.owned-all",
  context: z.array(z.object({ effect: z.string(), input: z.unknown() })),
  response: z.array(z.unknown()),
});
declare const resultType: unique symbol;
interface ChildCall<R> extends CapabilityRequest {
  readonly [resultType]: R;
}
interface ToolShape {
  readonly id: string;
  readonly context: StandardSchemaV1;
  readonly body: (...args: never[]) => Operation<unknown, unknown>;
}
type Result<T extends ToolShape> =
  ReturnType<T["body"]> extends Operation<infer R, unknown> ? R : never;
function child<T extends ToolShape>(
  tool: T,
  input: StandardSchemaV1.InferInput<T["context"]>,
): ChildCall<Result<T>> {
  // This witness is compile-time only. Admission separately checks granted identity.
  return { effect: tool.id, input } as ChildCall<Result<T>>;
}
function* all<const C extends readonly ChildCall<unknown>[]>(
  ...calls: C
): Operation<
  {
    -readonly [K in keyof C]: C[K][typeof resultType];
  },
  CapabilityRequest
> {
  if (!calls.length) {
    return [] as unknown as { -readonly [K in keyof C]: C[K][typeof resultType] };
  }
  const outcome = yield* group.call([...calls]);
  if (!outcome.ok) {
    throw new Error("Owned group admission failed");
  }
  // The trusted router binds each slot to the tool identified by its descriptor.
  return outcome.value as { -readonly [K in keyof C]: C[K][typeof resultType] };
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution.result;
  }
  function scenario(
    mode: "success" | "authored-failure" | "delivery-error" | "invalid-input" | "ungranted",
  ) {
    const counts = {
      securityInput: 0,
      performanceInput: 0,
      reads: 0,
      samples: 0,
      securityAcquire: 0,
      performanceAcquire: 0,
    };
    const read = defineEffect({ key: "tracer.read", context: z.string() }, function* (path) {
      counts.reads++;
      return { ok: true as const, value: `reviewed ${path}` };
    });
    const sample = defineEffect({ key: "tracer.sample", context: z.number() }, function* (budget) {
      counts.samples++;
      if (mode === "delivery-error") {
        throw new Error("Sampler connection lost");
      }
      return { ok: true as const, value: budget / 10 };
    });
    const approval = defineEffect({
      key: "tracer.approval",
      context: z.string(),
      response: z.boolean(),
    });
    const security = defineTool("tracer.security")
      .parameters(
        z.string().transform((path) => {
          counts.securityInput++;
          return { path: path.toLowerCase() };
        }),
      )
      .capabilities({ read })
      .execute(function* (input, ctx) {
        const result = yield* ctx.capabilities.read(input.path);
        if (!result.ok) {
          throw new Error("Read unavailable");
        }
        return { findings: [result.value] };
      });
    const performance = defineTool("tracer.performance")
      .parameters(
        z.number().transform((budget) => {
          counts.performanceInput++;
          return { budget };
        }),
      )
      .capabilities({ sample })
      .elicits({ approval })
      .execute(function* (input, ctx): Operation<
        Outcome<{ p95: number }, { code: "unavailable" }>,
        CapabilityRequest
      > {
        const sampled = yield* ctx.capabilities.sample(input.budget);
        if (!sampled.ok) {
          throw new Error("Sample unavailable");
        }
        const approved = yield* ctx.elicit("approval", "Publish timing?");
        return approved.ok && approved.value
          ? { ok: true, value: { p95: sampled.value } }
          : { ok: false, error: { code: "unavailable" } };
      });
    const review = defineTool("tracer.review")
      .parameters(z.string())
      .capabilities({ security, performance })
      .execute(function* (path) {
        const empty = yield* all();
        expectTypeOf(empty).toEqualTypeOf<[]>();
        expect(empty).toEqual([]);
        const tuple = yield* all(
          child(security, path),
          child(performance, mode === "invalid-input" ? Number.NaN : 500),
        );
        expectTypeOf(tuple).toEqualTypeOf<
          [{ findings: string[] }, Outcome<{ p95: number }, { code: "unavailable" }>]
        >();
        return tuple;
      });
    type Review = Result<typeof review>;
    type Child = OwnedChild<unknown, CapabilityRequest, unknown, string, unknown, Y>;
    const store = createSqliteJournalRig<Review, CapabilityRequest, unknown, string, unknown, Y>({
      program: review.id,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    let journal = store.open();
    let children: readonly Child[] = [];
    let wait: { child: Child; grant: ResolutionGrant } | undefined;
    let deferPerformance = false;

    function run() {
      return start(function* () {
        const effects = createEffectCapabilities(runtime, "owned-tool-all");
        const caller = effects.grant({ group });
        // The installed catalog is authority, distinct from importing a definition.
        const catalog = new Map<string, ToolShape>([[security.id, security]]);
        if (mode !== "ungranted") {
          catalog.set(performance.id, performance);
        }
        function* runTool<
          S extends StandardSchemaV1,
          D extends Record<string, EffectDefinition>,
          L extends Record<string, EffectDefinition>,
          R,
        >(tool: ToolDefinition<S, D, L, R>, owned: Child): Operation<boolean, Y> {
          // One trusted erasure seam: caller chooses this runner by pinned program identity.
          const bound = owned as OwnedChild<R, CapabilityRequest, unknown, string, unknown, Y>;
          const grants = () =>
            effects.grant({ ...tool.capabilities, ...tool.elicits }, { record: true });
          const current = runtime.composition.createContext<ReturnType<typeof grants>>(
            `grant:${tool.id}`,
          );
          const recovery = createRecovery(runtime.composition, {
            name: `recover:${tool.id}`,
            program: tool.id,
            matches: isDeepStrictEqual,
            *acquire() {
              if (tool.id === security.id) {
                counts.securityAcquire++;
              } else {
                counts.performanceAcquire++;
              }
              const grant = grants();
              yield* grant.install();
              yield* current.set(grant);
              const capabilities = effects.grant(tool.capabilities).capabilities;
              const elicits = effects.grant(tool.elicits).capabilities;
              return createScopedGuest((scope) =>
                tool.body(bound.link.input as StandardSchemaV1.InferOutput<S>, {
                  scope,
                  capabilities,
                  record: grant.record,
                  *await(factory, options) {
                    const recorded = yield* grant.record(function* () {
                      const value = yield* runtime.fromPromise(async (signal) => factory(signal));
                      return { ok: true as const, value };
                    }, options.record);
                    return recorded.value;
                  },
                  elicit<K extends keyof L>(key: K, ...args: Parameters<L[K]["call"]>) {
                    return elicits[key](args[0]) as ReturnType<L[K]["call"]>;
                  },
                }),
              );
            },
          });
          const host = createHosting(runtime.composition, {
            name: `host:${tool.id}`,
            journal: bound.journal,
            recovery: recovery.operations,
            attempts: bound.journal.attempts,
            interactions: bound.journal.interactions,
            *handle(request) {
              const grant = yield* current.expect();
              return yield* grant.handle(request);
            },
          });
          yield* host.around({
            *child(args, next) {
              const grant = yield* current.expect();
              return yield* grant.admission.child(args, next);
            },
            *deliveryMode([request], next) {
              return request.effect === approval.id ? "wait" : yield* next(request);
            },
          });
          yield* installGuestRetention(runtime.composition, host, recovery, bound.journal);
          const result = yield* host.operations.run();
          if (result.state === "waiting") {
            wait = { child: owned, grant: result.grant };
          }
          return result.state === "completed" || result.state === "cancelled";
        }
        yield* effects.install(read);
        yield* effects.install(sample);
        const recovery = createRecovery(runtime.composition, {
          name: "review-recovery",
          program: review.id,
          matches: isDeepStrictEqual,
          *acquire() {
            // This parent body only constructs group requests; no native bridge or record grant is needed.
            const parent = effects.grant(review.capabilities, { record: true });
            yield* parent.install();
            return createScopedGuest((scope) =>
              review.body("SRC", {
                scope,
                capabilities: parent.capabilities,
                record: parent.record,
                *await() {
                  throw new Error("Parent does not await recorded work");
                },
                elicit() {
                  throw new Error("Parent declares no elicits");
                },
              }),
            );
          },
        });
        const host = createHosting(runtime.composition, {
          name: "review-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          *handle() {
            throw new Error("Owned group must route to children");
          },
        });
        yield* host.around(caller.admission);
        yield* host.around({
          *child([pending], next) {
            if (pending.request.effect !== group.id) {
              return yield* next(pending);
            }
            const request = group.context["~standard"].validate(pending.request.input);
            const parsed = yield* runtime.fromPromise(async () => request);
            if (parsed.issues) {
              throw new Error("Invalid group request");
            }
            const descriptors = parsed.value;
            const definitions = descriptors.map((call) => {
              const definition = catalog.get(call.effect);
              if (!definition) {
                throw new Error("Child tool is not granted");
              }
              return definition;
            });
            const state = yield* journal.read();
            const links = state.status === "running" ? state.children : undefined;
            if (
              links &&
              (links.length !== descriptors.length ||
                links.some((link, index) => link.program !== descriptors[index]!.effect))
            ) {
              throw new Error("Group identity differs from stored call");
            }
            const inputs: unknown[] = [];
            for (const [index, definition] of definitions.entries()) {
              if (links) {
                inputs.push(links[index]!.input);
                continue;
              }
              const raw = descriptors[index]!.input;
              const result = yield* runtime.fromPromise(async () =>
                definition.context["~standard"].validate(raw),
              );
              if (result.issues) {
                throw new Error("Invalid child input");
              }
              inputs.push(result.value);
            }
            children = yield* journal.ensureChildren(pending.id, {
              children: descriptors.map((call, index) => ({
                program: call.effect,
                input: inputs[index],
              })),
              outcome: (values) => ({ ok: true, value: { ok: true, value: values } }),
            });
            return {
              id: pending.id,
              *run() {
                const settled = yield* runtime.all(
                  children.map(
                    (owned) =>
                      function* () {
                        if (owned.link.program === security.id) {
                          return yield* runTool(security, owned);
                        }
                        if (deferPerformance) {
                          return false;
                        }
                        return yield* runTool(performance, owned);
                      },
                  ),
                );
                return settled.every(Boolean);
              },
            };
          },
        });
        return yield* host.operations.run();
      });
    }
    return {
      counts,
      run,
      get children() {
        return children;
      },
      get journal() {
        return journal;
      },
      deferPerformance() {
        deferPerformance = true;
      },
      resumePerformance() {
        deferPerformance = false;
      },
      reopen() {
        journal = store.reopen();
        children = [];
        wait = undefined;
      },
      answer(value: boolean) {
        return start(function* () {
          if (!wait) {
            throw new Error("No participant wait");
          }
          const effects = createEffectCapabilities(runtime, "group-answers");
          // Ingress uses the ordinary response normalization without acquiring a Guest.
          const response = yield* effects
            .grant({ approval })
            .respond({ effect: approval.id, input: "Publish timing?" }, { ok: true, value });
          return yield* wait.child.journal.interactions.answer(wait.grant, {
            ok: true,
            value: response,
          });
        });
      },
      snapshot() {
        return start(() => readJournal(journal));
      },
    };
  }

  for (const mode of ["success", "authored-failure"] as const) {
    it(`${runtime.name}: heterogeneous tool all preserves typed slots and ${mode} across reopen`, async () => {
      const s = scenario(mode);
      expect((await s.run()).state).toBe("child");
      expect((await start(() => s.children[0]!.journal.read())).status).toBe("completed");
      expect(s.counts).toEqual({
        securityInput: 1,
        performanceInput: 1,
        reads: 1,
        samples: 1,
        securityAcquire: 1,
        performanceAcquire: 1,
      });
      const ids = s.children.map((entry) => entry.link.childId);
      s.reopen();
      expect((await s.run()).state).toBe("child");
      expect(s.children.map((entry) => entry.link.childId)).toEqual(ids);
      await s.answer(mode === "success");
      s.reopen();
      const value = [
        { findings: ["reviewed src"] },
        mode === "success"
          ? { ok: true, value: { p95: 50 } }
          : { ok: false, error: { code: "unavailable" } },
      ];
      await expect(s.run()).resolves.toEqual({ state: "completed", value });
      expect(s.counts).toEqual({
        securityInput: 1,
        performanceInput: 1,
        reads: 1,
        samples: 1,
        securityAcquire: 1,
        performanceAcquire: 3,
      });
      const snapshot = await s.snapshot();
      expect(snapshot.history).toHaveLength(1);
      expect(snapshot.history[0]!.request).toEqual({
        effect: group.id,
        input: [
          { effect: "tracer.security", input: "SRC" },
          { effect: "tracer.performance", input: 500 },
        ],
      });
      expect(snapshot.history[0]!.outcome).toEqual({ ok: true, value: { ok: true, value } });
      s.reopen();
      await expect(s.run()).resolves.toEqual({ state: "completed", value });
      expect(s.counts.securityAcquire).toBe(1);
      expect(s.counts.performanceAcquire).toBe(3);
    });
  }
  it(`${runtime.name}: a delivery error leaves its child occupied and retains its completed sibling`, async () => {
    const s = scenario("delivery-error");
    s.deferPerformance();
    expect((await s.run()).state).toBe("child");
    s.resumePerformance();
    await expect(s.run()).rejects.toThrow("Sampler connection lost");
    expect((await s.snapshot()).history).toHaveLength(0);
    const failed = s.children[1]!;
    const snapshot = await start(() => failed.journal.read());
    if (snapshot.status !== "running" || !snapshot.pending) {
      throw new Error("Expected unanswered effect");
    }
    expect(
      (await start(() => failed.journal.attempts.begin(snapshot.pending!.id, "unsafe"))).state,
    ).toBe("occupied");
    s.reopen();
    expect((await s.run()).state).toBe("child");
    expect(s.counts.reads).toBe(1);
    expect(s.counts.samples).toBe(1);
    expect(s.counts.securityAcquire).toBe(1);
    expect((await s.snapshot()).history).toHaveLength(0);
  });
  for (const mode of ["invalid-input", "ungranted"] as const) {
    it(`${runtime.name}: group ${mode} rejects before any child is created`, async () => {
      const s = scenario(mode);
      await expect(s.run()).rejects.toThrow(
        mode === "invalid-input" ? "Invalid child input" : "Child tool is not granted",
      );
      expect(s.children).toHaveLength(0);
      const snapshot = await s.snapshot();
      expect(snapshot.history).toHaveLength(0);
      if (snapshot.status !== "running") {
        throw new Error("Expected pending group");
      }
      expect(snapshot.children).toBeUndefined();
      expect(
        s.counts.reads + s.counts.samples + s.counts.securityAcquire + s.counts.performanceAcquire,
      ).toBe(0);
    });
  }
});
