import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import {
  createRecovery,
  createCheckpointMiddleware,
  type ResolutionGrant,
} from "@sweatpan.ts/durable";
import { createHosting, createEffectCapabilities } from "@sweatpan.ts/hosting";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { effects } from "../../../../../experiments/workflow-kernel/scriptc-scheme/contract.mts";
import { describeAuthoring } from "../../../../../experiments/workflow-kernel/scriptc-scheme/macros.mts";
import type { WorkflowModule } from "@sweatpan.ts/codemode-compiler";
import { schemeWorkflowTarget } from "@sweatpan.ts/codemode-compiler-scheme";
import { expect, it, onTestFinished } from "vitest";
import { createSchemeKernel } from "@sweatpan.ts/codemode-runtime-scheme";
import {
  loadSchemeMachine,
  schemeRuntimeIdentity,
} from "@sweatpan.ts/codemode-runtime-scheme/node";
import { source } from "../../../../../experiments/workflow-kernel/scriptc-scheme/generator.mjs";
import {
  frontend,
  input,
  authored,
  helper,
  admitWorkflow,
  debug,
  decodeRequest,
  bindEffectBoundary,
  authoringGuide,
} from "../../../../../experiments/workflow-kernel/scriptc-scheme/workflow.mjs";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime((runtime) => {
  for (const variant of [
    {
      name: "generator",
      source,
      request: (_key: string, message: string) => message,
      decodeRequest: (boundary: { value: unknown }) => boundary.value,
    },
    {
      name: "use workflow + imported helper",
      source: undefined,
      request: (key: string, message: string) => ({
        effect: `scriptc.review.${key}`,
        input: { message },
      }),
      decodeRequest,
    },
  ]) {
    for (const cancellation of ["none", "body", "cleanup"] as const) {
      it(`${runtime.name}: ScriptC ${variant.name} projection restores capture and ${cancellation} cancellation through cleanup`, async () => {
        await runtime.start(function* () {
          let source = variant.source;
          let decode = variant.decodeRequest;
          if (source === undefined) {
            const module = yield* frontend.lower(input);
            // The target receives only a serialized S-expression module: no
            // ScriptC nodes, source graph, declarations or live schema objects.
            const portable: WorkflowModule = JSON.parse(JSON.stringify(module));
            expect(portable.effects[Object.keys(portable.effects)[0]]).toMatchObject({
              effect: "scriptc.review.approval",
              source: { id: "review.workflow.ts" },
            });
            expect(() => bindEffectBoundary(portable, [])).toThrow(/Effect not granted/);
            decode = bindEffectBoundary(portable, [
              "scriptc.review.approval",
              "scriptc.review.cleanup",
            ]);
            source = schemeWorkflowTarget.emit(portable).source;
          }
          const kernel = createSchemeKernel(runtime, {
            identity: schemeRuntimeIdentity,
            loadMachine: loadSchemeMachine,
            decodeRequest: decode,
            decodeResult: (value) => value,
          });
          const recipe = yield* kernel.prepare(source, "draft");
          const guest = yield* recipe.acquire();
          yield* runtime.composition.ensure(() => guest.close());
          expect(yield* guest.start()).toMatchObject({
            kind: "suspended",
            request: variant.request("approval", "approve:draft"),
            scope: { phase: "body" },
          });
          const body = yield* recipe.checkpoints.capture(guest);
          yield* guest.close();
          const fresh = yield* kernel.prepare(source, "draft");
          const restored = yield* fresh.checkpoints.restore(body);
          yield* runtime.composition.ensure(() => restored.guest.close());
          const cleanup =
            cancellation === "body"
              ? yield* restored.guest.cancel!("stop")
              : yield* restored.guest.resume({ ok: true, value: "yes" });
          expect(cleanup).toMatchObject({
            kind: "suspended",
            request: variant.request(
              "cleanup",
              cancellation === "body" ? "release:draft" : "release:yes",
            ),
            scope: { phase: "cleanup" },
          });
          if (cancellation !== "none") {
            expect(yield* restored.guest.cancel!("stop")).toEqual(cleanup);
            expect(yield* restored.guest.cancel!("again")).toEqual(cleanup);
          }
          const saved = yield* fresh.checkpoints.capture(restored.guest);
          yield* restored.guest.close();
          const next = yield* kernel.prepare(source, "draft");
          const final = yield* next.checkpoints.restore(saved);
          yield* runtime.composition.ensure(() => final.guest.close());
          expect(final.turn).toEqual(cleanup);
          expect(yield* final.guest.resume({ ok: true, value: "released" })).toEqual(
            cancellation === "none"
              ? { kind: "completed", value: "approved:yes" }
              : { kind: "cancelled", reason: "stop" },
          );
        }).result;
      });
    }
  }
});

it("workflow admission retains authored elicit locations and refuses unsupported capabilities before execution", () => {
  expect(
    Object.values(debug.sites).map(({ sourceId, line, key }) => ({ sourceId, line, key })),
  ).toEqual([
    { sourceId: "review.workflow.ts", line: 9, key: "approval" },
    { sourceId: "review.workflow.ts", line: 13, key: "cleanup" },
  ]);
  expect(() => admitWorkflow(authored, helper, { approval: input.effects.approval })).toThrow(
    /undeclared effect/,
  );
  expect(() =>
    decodeRequest({ site: "unknown", value: ["effect", "scriptc.review.approval", "draft"] }),
  ).toThrow(/admitted effect/);
  expect(() =>
    decodeRequest({
      site: Object.keys(debug.sites)[0],
      value: ["effect", "scriptc.review.cleanup", "draft"],
    }),
  ).toThrow(/admitted effect/);
  expect(authoringGuide.map((macro) => macro.method)).toEqual(["elicit", "effect"]);
  expect(
    authoringGuide.flatMap((macro) => macro.bindings.map((binding) => binding.effect)),
  ).toEqual(["scriptc.review.approval", "scriptc.review.cleanup"]);
  expect(authoringGuide[0].bindings[0].input).toMatchObject({
    type: "object",
    properties: { message: { type: "string" } },
  });
  expect(authoringGuide[0].bindings[0].response).toMatchObject({ type: "string" });
  expect(Object.values(debug.sites).map((site) => site.operation)).toEqual(["effect", "effect"]);
  const rejected = [
    authored.replace("title: string", "title: number"),
    authored.replace("Operation<string>", "Operation<number>"),
    authored.replace("ctx: WorkflowContext", "ctx: unknown"),
    authored.replace("ctx: WorkflowContext", "ctx: WorkflowContext<string>"),
    ...[
      "globalThis?.process",
      "eval",
      "globalThis",
      "(() => eval)",
      "import('node:fs')",
      "this",
      "'x' as string",
    ].map((expression) =>
      authored.replace(
        "  let reservation",
        `  const forbidden = ${expression};\n  let reservation`,
      ),
    ),
    authored.replace("ctx.effect('cleanup'", "ctx.elicit('cleanup'"),
    authored.replace("'use workflow';", ""),
    authored.replace("'approval', { message:", "'unknown', { message:"),
    authored.replace("ctx.elicit('approval'", "ctx.sample('approval'"),
    authored.replace("  let reservation", "  const alias = ctx;\n  let reservation"),
    authored.replace("  let reservation", "  ctx = ctx;\n  let reservation"),
    authored.replace("  let reservation", "  console.log('host');\n  let reservation"),
    authored.replace("  let reservation", "  yield 'untyped';\n  let reservation"),
    authored.replace("./helper.js", "node:fs"),
    authored + "\nconsole.log('module side effect');",
  ];
  for (const text of rejected) {
    expect(() => admitWorkflow(text, helper)).toThrow(/Workflow admission/);
  }
  expect(() => admitWorkflow(authored, helper + "\nconsole.log('helper side effect');")).toThrow(
    /Workflow admission/,
  );
});

it("selected declarations must fit the compiler encoding and drive authoring guidance", () => {
  const selected = { ...effects, approval: { ...effects.approval, id: "selected.approval" } };
  expect(describeAuthoring(selected)[0].bindings[0].effect).toBe("selected.approval");
  expect(admitWorkflow(authored, helper, selected).source).toContain("selected.approval");
  expect(() =>
    admitWorkflow(authored, helper, {
      ...effects,
      approval: {
        ...effects.approval,
        context: z.object({ message: z.string() }),
        response: z.string(),
      },
    }),
  ).not.toThrow();
  for (const replacement of [
    { context: z.object({ message: z.number() }) },
    { context: z.object({ message: z.string(), extra: z.string() }) },
    { response: z.number() },
    { response: z.coerce.string() },
    { response: z.string().min(1) },
    { response: z.string().refine(() => false) },
    { response: z.string().transform((value) => value.length) },
  ]) {
    const incompatible = { ...effects, approval: { ...effects.approval, ...replacement } };
    expect(() => describeAuthoring(incompatible)).toThrow(/unsupported declaration profile/);
    expect(() => admitWorkflow(authored, helper, incompatible)).toThrow(
      /unsupported declaration profile/,
    );
  }
  expect(() => admitWorkflow(authored, helper.replace("prefix: string", "prefix: number"))).toThrow(
    /helper declaration/,
  );
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: compiled workflow answers use host schemas and exact journal authority across reopen`, async () => {
    const program = "scriptc-hosted-review";
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, unknown, unknown, Y>({
      program,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    function assemble(answer?: { grant: ResolutionGrant; value: unknown; denied?: boolean }) {
      return runtime.start(function* () {
        const module = yield* frontend.lower(input);
        const recipe = yield* createSchemeKernel(runtime, {
          identity: schemeRuntimeIdentity,
          loadMachine: loadSchemeMachine,
          decodeRequest: bindEffectBoundary(
            module,
            Object.values(effects).map((effect) => effect.id),
          ),
          decodeResult: (value) => z.string().parse(value),
        }).prepare(schemeWorkflowTarget.emit(module).source, "draft");
        const recovery = createRecovery(runtime.composition, {
          name: "compiled-recovery",
          program,
          matches: isDeepStrictEqual,
          acquire: recipe.acquire,
        });
        yield* recovery.around(
          createCheckpointMiddleware({
            execution: recovery.execution,
            program,
            matches: isDeepStrictEqual,
            adapter: recipe.checkpoints,
          }),
        );
        const journal = store.open();
        const capabilities = createEffectCapabilities(runtime, "compiled-effects");
        const granted = capabilities.grant(effects);
        const host = createHosting(runtime.composition, {
          name: "compiled-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          *handle() {
            throw new Error("Participant input required");
          },
        });
        yield* host.around(granted.admission);
        yield* host.around({
          *deliveryMode() {
            return "wait";
          },
        });
        if (answer) {
          // This experimental compiler unwraps successful values. Reuse host
          // validation, then store that Outcome directly (no ToolContext wrapper).
          const request = yield* journal.interactions.request(answer.grant);
          const selected = answer.denied
            ? capabilities.grant({ cleanup: effects.cleanup })
            : granted;
          const outcome = yield* selected.respond(request, { ok: true, value: answer.value });
          yield* host.operations.answer(answer.grant, outcome);
        }
        return yield* host.operations.run();
      }).result;
    }
    const approval = await assemble();
    if (approval.state !== "waiting") {
      throw new Error("Expected approval wait");
    }
    const before = await runtime.start(() => store.open().read()).result;
    await expect(assemble({ grant: approval.grant, value: 42 })).rejects.toThrow(
      "Effect schema rejected value",
    );
    await expect(assemble({ grant: approval.grant, value: "yes", denied: true })).rejects.toThrow(
      "Effect is not granted",
    );
    await expect(
      assemble({ grant: { ...approval.grant, resolutionId: "forged" }, value: "yes" }),
    ).rejects.toThrow("Unknown resolution authority");
    const after = await runtime.start(() => store.open().read()).result;
    expect(after.frontier.position).toBe(before.frontier.position);
    expect(after).toMatchObject({
      status: "running",
      interaction: { state: "waiting", grant: approval.grant },
    });
    store.reopen();
    const cleanup = await assemble({ grant: approval.grant, value: "yes" });
    if (cleanup.state !== "waiting") {
      throw new Error("Expected cleanup wait");
    }
    expect(
      await runtime.start(() => store.open().interactions.request(cleanup.grant)).result,
    ).toEqual({
      effect: effects.cleanup.id,
      input: { message: "release:yes" },
    });
    store.reopen();
    expect(await assemble({ grant: cleanup.grant, value: "released" })).toEqual({
      state: "completed",
      value: "approved:yes",
    });
  });
});
