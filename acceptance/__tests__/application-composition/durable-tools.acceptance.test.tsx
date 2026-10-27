import { call, ensure, run, spawn, type Operation } from "effection";
import { defineDurableContextExtension } from "@sweatpants/agent-sdk";
import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { inProcess } from "@sweatpants/agent-host/server";
import { routeTools } from "@sweatpants/tool-session/execution";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { durableSelection, selectionEffects } from "../../fixtures/durable-selection.ts";
import { selectionPlugin } from "../../fixtures/selection-plugin.tsx";
import { immediateTool } from "../../fixtures/immediate-tool.ts";
import { testToolRuntime } from "../../support/test-tool-runtime.ts";
import { useUI } from "../../support/ui.tsx";

const options = {
  binding: "http" as const,
  createApplication: (context: Parameters<typeof createApplication>[0]) =>
    createApplication(context, {
      tools: [durableSelection],
      effects: selectionEffects(),
      execution: inProcess(),
    }),
};

describe("durable tool authoring", () => {
  for (const outcome of ["accept", "decline", "cancel"] as const) {
    it(`replays a durable tool through sampling and a typed ${outcome} choice`, async () => {
      const effects: string[] = [];
      await withTestScenario(
        {
          ...options,
          createApplication: (context) =>
            createApplication(context, {
              tools: [durableSelection],
              effects: selectionEffects((topic) => effects.push(topic)),
              execution: inProcess(),
            }),
        },
        function* (rig) {
          // Arrange: the real durable program runs under the host crank.
          using ui = yield* useUI(rig, { plugins: [selectionPlugin] });
          const send = yield* ui.waitForEnabledButton("Book trip");

          // Act: execute the recorded effect and private nested sample before parking.
          send.click();
          const outer = yield* rig.model.request();
          yield* outer.respond.toolCalls([
            { id: "selection", name: "select_option", arguments: { topic: "trains" } },
          ]);
          const nested = yield* rig.model.request();
          expect(nested.pullId).not.toBe(outer.pullId);
          expect(JSON.stringify(nested.body.input)).toContain("PRIVATE_SELECTION_NOTE");
          yield* nested.respond.text("Take the express");
          const choice = yield* ui.waitForEnabledButton(
            outcome === "accept"
              ? "trains-beta"
              : outcome === "decline"
                ? "Decline"
                : "Cancel choice",
          );
          choice.click();
          const final = yield* rig.model.request();

          // Assert: replay retains the sample/record and never re-executes the effect.
          expect(effects).toEqual(["trains"]);
          expect(JSON.stringify(final.body.input)).toContain(
            outcome === "accept" ? "trains-beta" : "none",
          );
          expect(JSON.stringify(final.body.input)).toContain("trains-recorded");
          expect(JSON.stringify(final.body.input)).toContain("Take the express");
          expect(JSON.stringify(final.body.input)).not.toContain("PRIVATE_SELECTION_NOTE");
          yield* final.respond.text("Selection complete");
          yield* ui.waitForText("Selection complete");
          yield* ui.waitForEnabledButton("Book trip");

          // Act: send a successor and inspect its unnormalized provider history.
          ui.getByRole("button", { name: "Book trip" }).click();
          const next = yield* rig.model.request();
          const input = next.body.input;
          if (!Array.isArray(input)) {
            throw new Error("Expected provider history");
          }
          expect(
            input.filter(
              (item: Record<string, unknown>) =>
                item["type"] === "function_call_output" && item["call_id"] === "selection",
            ),
          ).toHaveLength(1);
          expect(JSON.stringify(input)).not.toContain("PRIVATE_SELECTION_NOTE");
          yield* next.respond.text("Successor complete");
          yield* ui.waitForText("Successor complete");
          yield* ui.waitForEnabledButton("Book trip");
          expect(effects).toEqual(["trains"]);
        },
      );
    });
  }

  it("owns immutable extension clients through nested, concurrent, failed and cancelled invocations", async () => {
    const identities = new WeakMap<object, number>();
    const closed: number[] = [];
    const cleanupValues: number[] = [];
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const bothReady = Promise.withResolvers<void>();
    const cancelledReady = Promise.withResolvers<void>();
    let waiting = 0;
    let nextIdentity = 0;
    let leaked: { read(): Operation<number> } | undefined;
    const extension = defineDurableContextExtension({
      name: "acceptance-scoped-client",
      api: {
        *read(): Operation<number> {
          throw new Error("missing client");
        },
        *recursive(): Operation<number> {
          throw new Error("missing client");
        },
        *record(): Operation<string> {
          throw new Error("missing client");
        },
      },
      client({ context, self }) {
        let registered = false;
        return {
          *read() {
            expect(Object.isFrozen(self)).toBe(true);
            let identity = identities.get(context);
            if (identity === undefined) {
              identity = ++nextIdentity;
              identities.set(context, identity);
            }
            if (!registered) {
              registered = true;
              yield* ensure(function* () {
                yield* call(() => Promise.resolve());
                cleanupValues.push(yield* self.read());
                closed.push(identity!);
              });
            }
            return identity;
          },
          *recursive() {
            return yield* self.read();
          },
          *record() {
            return yield* context.record({ key: "extension-context-record" }, function* () {
              return "recorded through the installed context";
            });
          },
        };
      },
    });
    const child = createDurableTool("scoped_child")
      .description("Nested scope-owned client")
      .identity({ version: "1", digest: "a".repeat(64) })
      .parameters(z.object({ mode: z.enum(["success", "failure", "cancel"]) }))
      .uses({ extension })
      .execute(function* ({ mode }, ctx) {
        const identity = yield* ctx.extension.recursive();
        if (mode === "failure") {
          throw new Error("child failed");
        }
        if (mode === "cancel") {
          cancelledReady.resolve();
          yield* call(() => new Promise<never>(() => {}));
        }
        ready.resolve();
        if (++waiting === 2) {
          bothReady.resolve();
        }
        yield* call(() => release.promise);
        return identity;
      });
    const tool = createDurableTool("scoped_extensions")
      .description("Exercise extension invocation lifetimes through the host")
      .identity({ version: "1", digest: "b".repeat(64) })
      .parameters(z.object({}))
      .uses({ extension })
      .execute(function* (_input, ctx) {
        try {
          leaked = ctx.extension;
          expect(ctx.use(extension)).toBe(ctx.extension);
          expect(
            Reflect.set(ctx.extension, "read", function* () {
              return -100;
            }),
          ).toBe(false);
          expect(Object.isFrozen(ctx.extension)).toBe(true);
          const parent = yield* ctx.extension.read();
          const recorded = yield* ctx.extension.record();
          yield* extension.clientApi.around(
            {
              *read(args, next) {
                return (yield* next(...args)) + 10;
              },
            },
            { at: "min" },
          );
          yield* extension.clientApi.around(
            {
              *read(args, next) {
                return (yield* next(...args)) * 2;
              },
            },
            { at: "max" },
          );
          yield* extension.clientApi.around({
            *read(args, next) {
              return (yield* next(...args)) + 1;
            },
          });
          // Forward the real host authority through distinct invocation contexts.
          // The factory must retain each context while lazy calls select its scope.
          const first = yield* spawn(() => child.program({ mode: "success" }, { ...ctx }));
          yield* call(() => ready.promise);
          const second = yield* spawn(() => child.program({ mode: "success" }, { ...ctx }));
          yield* call(() => bothReady.promise);
          // Both children have executed up to the same deterministic gate.
          expect(nextIdentity).toBe(3);
          expect(yield* ctx.extension.recursive()).toBe(24);
          release.resolve();
          expect(yield* first).toBe(26);
          expect(yield* second).toBe(28);
          expect(closed).toEqual([2, 3]);
          try {
            yield* child.program({ mode: "failure" }, { ...ctx });
            throw new Error("expected child failure");
          } catch (error) {
            expect(String(error)).toContain("child failed");
          }
          expect(closed).toEqual([2, 3, 4]);
          const cancelled = yield* spawn(() => child.program({ mode: "cancel" }, { ...ctx }));
          yield* call(() => cancelledReady.promise);
          yield* cancelled.halt();
          expect(closed).toEqual([2, 3, 4, 5]);
          expect(yield* ctx.extension.recursive()).toBe(24);
          return { parent, recorded, restored: yield* ctx.extension.recursive() };
        } catch (error) {
          return { failure: String(error) };
        }
      });
    await withTestScenario(
      {
        ...options,
        createApplication: (context) =>
          createApplication(context, {
            tools: [tool],
            execution: inProcess(),
          }),
      },
      function* (rig) {
        using ui = yield* useUI(rig, { plugins: [selectionPlugin] });
        (yield* ui.waitForEnabledButton("Book trip")).click();
        const request = yield* rig.model.request();
        yield* request.respond.toolCalls([
          { id: "scoped", name: "scoped_extensions", arguments: {} },
        ]);
        const final = yield* rig.model.request();
        yield* final.respond.text("Scopes complete");
        yield* ui.waitForText("Scopes complete");
        yield* ui.waitForEnabledButton("Book trip");
        expect(JSON.stringify(final.body.input)).toContain(
          "recorded through the installed context",
        );
        const outputs = (final.body.input as { type: string; output?: string }[])
          .filter((item) => item.type === "function_call_output")
          .map((item) => JSON.parse(item.output!));
        expect(outputs).toEqual([
          { parent: 1, recorded: "recorded through the installed context", restored: 24 },
        ]);
        expect(closed).toEqual([2, 3, 4, 5, 1]);
        expect(cleanupValues).toEqual([26, 28, 30, 32, 24]);
      },
    );
    expect(leaked).toBeDefined();
    await expect(Promise.resolve(run(() => leaked!.read()))).rejects.toThrow("not context-bound");
  });

  it("routes ordinary and durable calls from the same model response", async () => {
    await withTestScenario(
      {
        ...options,
        createApplication: (context) =>
          createApplication(context, {
            tools: [immediateTool, durableSelection],
            effects: selectionEffects(),
            execution: routeTools({
              routes: [
                { tools: [immediateTool], runtime: testToolRuntime() },
                { tools: [durableSelection], runtime: inProcess() },
              ],
            }),
          }),
      },
      function* (rig) {
        // Arrange: placement is selected on the public application configuration.
        using ui = yield* useUI(rig, { plugins: [selectionPlugin] });

        // Act: the model selects one ordinary and one durable tool.
        const send = yield* ui.waitForEnabledButton("Book trip");
        send.click();
        const request = yield* rig.model.request();
        yield* request.respond.toolCalls([
          { id: "ordinary", name: "immediate", arguments: { value: "ordinary" } },
          { id: "durable", name: "select_option", arguments: { topic: "mixed" } },
        ]);
        const nested = yield* rig.model.request();
        yield* nested.respond.text("Mixed note");
        const choice = yield* ui.waitForEnabledButton("mixed-alpha");
        choice.click();
        const final = yield* rig.model.request();
        const input = final.body.input;
        if (!Array.isArray(input)) {
          throw new Error("Expected provider history");
        }

        // Assert: both placements contribute exactly one correlated result before the final sample.
        expect(
          input
            .filter((item: Record<string, unknown>) => item["type"] === "function_call_output")
            .map((item: Record<string, unknown>) => item["call_id"]),
        ).toEqual(["ordinary", "durable"]);
        expect(JSON.stringify(input)).toContain("mixed-alpha");
        yield* final.respond.text("Both complete");
        yield* ui.waitForText("Both complete");
        yield* ui.waitForEnabledButton("Book trip");
        expect(rig.model.requests()).toHaveLength(3);
      },
    );
  });
});
