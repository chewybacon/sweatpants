import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createLuaKernel, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import {
  createCheckpointMiddleware,
  createRecovery,
  type ResolutionGrant,
} from "@sweatpan.ts/durable";
import { createEffectCapabilities, createHosting } from "@sweatpan.ts/hosting";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import {
  frontend,
  input,
  outcomeFrontend,
  outcomeInput,
} from "../../../../../experiments/workflow-kernel/scriptc-scheme/workflow.mjs";
import { effects } from "../../../../../experiments/workflow-kernel/scriptc-scheme/contract.mts";
import {
  linkLuaReview,
  luaWorkflowLinker,
  bindLuaReviewBoundary,
} from "../../../../../experiments/workflow-kernel/scriptc-scheme/lua-target.mts";
import { forEachRuntime } from "../runtime/assembly.ts";

const caller = `local answer = review_draft(input)
if "caller:" .. answer == "caller:approved:yes" then return "caller:" .. answer else return "caller:declined" end`;
const bytes = await readFile(luaWasmUrl);
const identity = createHash("sha256").update(bytes).digest("hex");
let wasm: Promise<WebAssembly.Module> | undefined;
const loadModule = () => (wasm ??= WebAssembly.compile(bytes));
const allowed = Object.values(effects).map((effect) => effect.id);
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const approved of [true, false]) {
    it(`${runtime.name}: authored TypeScript Outcome branch ${approved} runs in lua across restore and cleanup`, async () => {
      const module = await runtime.start(() => outcomeFrontend.lower(outcomeInput)).result;
      const artifact = luaWorkflowLinker.link({
        module,
        caller: { language: "lua", text: "return review_draft(input)" },
        name: "review_draft",
        identity: identity,
      });
      await runtime.start(function* () {
        const recipe = yield* createLuaKernel(runtime, {
          loadModule,
          decodeRequest: bindLuaReviewBoundary(module, allowed),
          decodeResult: (value) => value,
        }).prepare(artifact.source, "draft");
        const guest = yield* recipe.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        expect(yield* guest.start()).toMatchObject({
          kind: "suspended",
          request: { effect: effects.approval.id, input: { message: "approve:draft" } },
        });
        const saved = yield* recipe.checkpoints.capture(guest);
        yield* guest.close();
        const restored = yield* recipe.checkpoints.restore(saved);
        yield* runtime.composition.ensure(() => restored.guest.close());
        const outcome = approved ? { ok: true, value: "yes" } : { ok: false, error: "denied" };
        expect(yield* restored.guest.resume({ ok: true, value: outcome })).toMatchObject({
          kind: "suspended",
          scope: { phase: "cleanup" },
          request: { effect: effects.cleanup.id, input: { message: "release:draft" } },
        });
        const cleanup = yield* recipe.checkpoints.capture(restored.guest);
        yield* restored.guest.close();
        const final = yield* recipe.checkpoints.restore(cleanup);
        yield* runtime.composition.ensure(() => final.guest.close());
        // This author explicitly ignores cleanup's domain result; no implicit throw.
        expect(
          yield* final.guest.resume({ ok: true, value: { ok: false, error: "already released" } }),
        ).toEqual({ kind: "completed", value: approved ? "approved:yes" : "rejected:denied" });
      }).result;
    });
  }

  it(`${runtime.name}: lua raw effect preserves domain success and rejection as data across restore`, async () => {
    const base = await runtime.start(() => frontend.lower(input)).result;
    const site = Object.keys(base.effects)[0]!;
    const effect = base.effects[site]!;
    // No authoring unwrap: the exact same effect boundary can expose Outcome data.
    const module = {
      ...base,
      sexpressions: `(define (review input) (workflow-return (yield-at ${JSON.stringify(site)} (list "effect" ${JSON.stringify(effect.effect)} input))))`,
    };
    const artifact = luaWorkflowLinker.link({
      module,
      caller: { language: "lua", text: "return review_draft(input)" },
      name: "review_draft",
      identity: identity,
    });
    for (const outcome of [
      { ok: true, value: "yes" },
      { ok: false, error: "declined" },
    ]) {
      await runtime.start(function* () {
        const recipe = yield* createLuaKernel(runtime, {
          loadModule,
          decodeRequest: bindLuaReviewBoundary(module, allowed),
          decodeResult: (value) => value,
        }).prepare(artifact.source, "draft");
        const guest = yield* recipe.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        expect(yield* guest.start()).toMatchObject({
          kind: "suspended",
          request: { effect: effect.effect, input: { message: "draft" } },
        });
        const saved = yield* recipe.checkpoints.capture(guest);
        yield* guest.close();
        const restored = yield* recipe.checkpoints.restore(saved);
        yield* runtime.composition.ensure(() => restored.guest.close());
        expect(yield* restored.guest.resume({ ok: true, value: outcome })).toEqual({
          kind: "completed",
          value: outcome,
        });
      }).result;
    }
  });

  it(`${runtime.name}: lua linker rejects unsupported caller language and binding`, async () => {
    const module = await runtime.start(() => frontend.lower(input)).result;
    const request = {
      module,
      caller: { language: "lua", text: caller },
      name: "review_draft",
      identity: "test-runtime",
    };
    expect(() =>
      luaWorkflowLinker.link({ ...request, caller: { ...request.caller, language: "python" } }),
    ).toThrow();
    expect(() => luaWorkflowLinker.link({ ...request, name: "if" })).toThrow();
    const linked = luaWorkflowLinker.link(request);
    expect(linked).toMatchObject({
      language: "lua",
      name: "review_draft",
      entry: module.entry.name,
      effects: module.effects,
    });
    expect(luaWorkflowLinker.link({ ...request, identity: "another-runtime" }).program).not.toBe(
      linked.program,
    );
  });

  for (const choice of ["approve", "decline", "cancel-body", "cancel-cleanup"] as const) {
    it(`${runtime.name}: compiled shared IR runs inside linked Lua through ${choice} and reopen`, async () => {
      const module = await runtime.start(() => frontend.lower(input)).result;
      const artifact = luaWorkflowLinker.link({
        module: JSON.parse(JSON.stringify(module)),
        caller: { language: "lua", text: caller },
        name: "review_draft",
        identity,
      });
      const store = createSqliteJournalRig<string, CapabilityRequest, unknown, unknown, unknown, Y>(
        { program: artifact.program, equals: isDeepStrictEqual },
      );
      onTestFinished(() => store.close());
      let starts = 0,
        restores = 0;
      const kernel = createLuaKernel(runtime, {
        loadModule,
        decodeRequest: bindLuaReviewBoundary(module, allowed),
        decodeResult(value) {
          if (typeof value !== "string") {
            throw new Error("Expected string result");
          }
          return value;
        },
      });
      const run = (command?: { answer: ResolutionGrant; value: unknown } | { cancel: string }) =>
        runtime.start(function* () {
          const recipe = yield* kernel.prepare(artifact.source, "draft");
          const journal = store.open();
          const recovery = createRecovery(runtime.composition, {
            name: "linked-lua",
            program: artifact.program,
            matches: isDeepStrictEqual,
            *acquire() {
              starts++;
              return yield* recipe.acquire();
            },
          });
          yield* recovery.around(
            createCheckpointMiddleware({
              execution: recovery.execution,
              program: artifact.program,
              matches: isDeepStrictEqual,
              adapter: {
                ...recipe.checkpoints,
                *restore(state: unknown) {
                  restores++;
                  return yield* recipe.checkpoints.restore(state);
                },
              },
            }),
          );
          const grant = createEffectCapabilities(runtime, "linked-lua-effects").grant(effects);
          const host = createHosting(runtime.composition, {
            name: "linked-lua-host",
            journal,
            recovery: recovery.operations,
            attempts: journal.attempts,
            interactions: journal.interactions,
            *handle() {
              throw new Error("Participant input required");
            },
          });
          yield* host.around(grant.admission);
          yield* host.around({
            *deliveryMode() {
              return "wait";
            },
          });
          if (command && "answer" in command) {
            const request = yield* journal.interactions.request(command.answer);
            const response = yield* grant.respond(request, { ok: true, value: command.value });
            yield* host.operations.answer(command.answer, { ok: true, value: response });
          } else if (command) {
            yield* host.operations.cancel(command.cancel, "stop");
          }
          return yield* host.operations.run();
        }).result;
      const first = await run();
      if (first.state !== "waiting") {
        throw new Error("Expected approval");
      }
      expect(first.pending.request).toEqual({
        effect: effects.approval.id,
        input: { message: "approve:draft" },
      });
      await expect(run({ answer: first.grant, value: 42 })).rejects.toThrow(
        "Effect schema rejected",
      );
      store.reopen();
      expect(await run()).toMatchObject({ state: "waiting", grant: first.grant });
      const second =
        choice === "cancel-body"
          ? await run({ cancel: first.grant.requestId })
          : await run({ answer: first.grant, value: choice === "decline" ? "no" : "yes" });
      if (second.state !== "waiting") {
        throw new Error("Expected cleanup");
      }
      expect(second.pending.request).toEqual({
        effect: effects.cleanup.id,
        input: {
          message: `release:${choice === "cancel-body" ? "draft" : choice === "decline" ? "no" : "yes"}`,
        },
      });
      if (choice.startsWith("cancel")) {
        expect(
          await run({
            cancel: choice === "cancel-body" ? first.grant.requestId : second.grant.requestId,
          }),
        ).toMatchObject({ state: "waiting", grant: second.grant });
      }
      store.reopen();
      expect(await run({ answer: second.grant, value: "released" })).toMatchObject(
        choice.startsWith("cancel")
          ? { state: "cancelled", reason: "stop" }
          : {
              state: "completed",
              value: choice === "approve" ? "caller:approved:yes" : "caller:declined",
            },
      );
      if (!choice.startsWith("cancel")) {
        expect(starts).toBe(1);
        expect(restores).toBeGreaterThanOrEqual(2);
      }
      const before = { starts, restores };
      await run();
      expect({ starts, restores }).toEqual(before);
    });
  }
  it(`${runtime.name}: rejected compiled approval still runs cleanup inside Lua`, async () => {
    const module = await runtime.start(() => frontend.lower(input)).result;
    const artifact = linkLuaReview({ module, caller, identity });
    await runtime.start(function* () {
      const kernel = createLuaKernel(runtime, {
        loadModule,
        decodeRequest: bindLuaReviewBoundary(module, allowed),
        decodeResult: (value) => value,
      });
      const recipe = yield* kernel.prepare(artifact.source, "draft");
      const guest = yield* recipe.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      yield* guest.start();
      const cleanup = yield* guest.resume({
        ok: true,
        value: { ok: false, error: "approval unavailable" },
      });
      expect(cleanup).toMatchObject({
        kind: "suspended",
        scope: { phase: "cleanup" },
        request: { effect: effects.cleanup.id, input: { message: "release:draft" } },
      });
      const saved = yield* recipe.checkpoints.capture(guest);
      yield* guest.close();
      const restored = yield* recipe.checkpoints.restore(saved);
      yield* runtime.composition.ensure(() => restored.guest.close());
      const failure = yield* runtime.composition.catchError(
        () => restored.guest.resume({ ok: true, value: { ok: true, value: "released" } }),
        function* (error) {
          return error;
        },
      );
      expect(failure).toMatchObject({ name: "LuaFailure", value: "approval unavailable" });
    }).result;
  });

  it(`${runtime.name}: Lua rejects long comments without activating commented entry calls`, async () => {
    const module = await runtime.start(() => frontend.lower(input)).result;
    for (const equals of ["", "=", "=="]) {
      const source = `--[${equals}[\nlocal answer = review_draft(input)\n--]${equals}]\nreturn "skipped"`;
      expect(() => linkLuaReview({ module, caller: source, identity })).toThrow("long comments");
    }
    const artifact = linkLuaReview({
      module,
      caller: '-- ordinary comment\nreturn "--[[literal comment text]]"',
      identity,
    });
    let requests = 0;
    await runtime.start(function* () {
      const recipe = yield* createLuaKernel(runtime, {
        loadModule,
        decodeRequest() {
          requests++;
          throw new Error("Unexpected effect");
        },
        decodeResult: (value) => value,
      }).prepare(artifact.source, "draft");
      const guest = yield* recipe.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      expect(yield* guest.start()).toEqual({
        kind: "completed",
        value: "--[[literal comment text]]",
      });
    }).result;
    expect(requests).toBe(0);
  });

  it(`${runtime.name}: compiled Lua preserves empty arrays and well-formed Unicode`, async () => {
    const base = await runtime.start(() => frontend.lower(input)).result;
    for (const [expression, expected] of [
      ["(list)", []],
      ['((lambda () ""))', ""],
      ['(list (list) "x")', [[], "x"]],
      [JSON.stringify("emoji 😀 café \u0001"), "emoji 😀 café \u0001"],
    ] as const) {
      const module = {
        ...base,
        sexpressions: `(define (review input) (workflow-return ${expression}))`,
      };
      const artifact = linkLuaReview({ module, caller: "return review_draft(input)", identity });
      await runtime.start(function* () {
        const recipe = yield* createLuaKernel(runtime, {
          loadModule,
          decodeRequest: bindLuaReviewBoundary(module, allowed),
          decodeResult: (value) => value,
        }).prepare(artifact.source, "draft");
        const guest = yield* recipe.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        expect(yield* guest.start()).toEqual({ kind: "completed", value: expected });
      }).result;
    }
    for (const invalid of ["\ud800", "\udfff"]) {
      expect(() =>
        linkLuaReview({
          module: {
            ...base,
            sexpressions: `(define (review input) (workflow-return ${JSON.stringify(invalid)}))`,
          },
          caller: "return review_draft(input)",
          identity,
        }),
      ).toThrow("well-formed Unicode");
      expect(() =>
        linkLuaReview({ module: base, caller: `return "${invalid}"`, identity }),
      ).toThrow("well-formed Unicode");
    }
  });

  it(`${runtime.name}: unsupported lambda bodies reject and workflow fallthrough fails explicitly`, async () => {
    const base = await runtime.start(() => frontend.lower(input)).result;
    for (const sexpressions of [
      '(define (review input) (workflow-return ((lambda (a a) a) "first" "second")))',
      "(define (review input input) (workflow-return input))",
      '(define (review input) (define x "init") (define f (lambda (v) (set! x v))) (workflow-return (list (f "updated") x)))',
      '(define (review input) (workflow-return ((lambda () (define x "value")))))',
      "(define (review input) (workflow-return ((lambda ()))))",
      '(define (review input) (workflow-return ((lambda (x) (if x (block "yes") (block "no"))) input)))',
    ]) {
      expect(() => linkLuaReview({ module: { ...base, sexpressions }, caller, identity })).toThrow(
        /Unsupported Lua workflow IR|Invalid workflow module/,
      );
    }
    const module = { ...base, sexpressions: '(define (review input) (js-add input "x"))' };
    const artifact = linkLuaReview({ module, caller: "return review_draft(input)", identity });
    await runtime.start(function* () {
      const recipe = yield* createLuaKernel(runtime, {
        loadModule,
        decodeRequest: bindLuaReviewBoundary(module, allowed),
        decodeResult: (value) => value,
      }).prepare(artifact.source, "draft");
      const guest = yield* recipe.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      const failure = yield* runtime.composition.catchError(
        () => guest.start(),
        function* (error) {
          return error;
        },
      );
      expect(failure).toMatchObject({
        name: "LuaFailure",
        value: "Compiled workflow fell through without returning",
      });
    }).result;
  });

  it(`${runtime.name}: Lua caller cannot enter private functions or forge compiled effects`, async () => {
    const module = await runtime.start(() => frontend.lower(input)).result;
    for (const bad of [
      "return review(input)",
      'return workflow.effect("scriptc:353", input)',
      "return __effect(input)",
      "local review_draft = input return review_draft",
      "end)() return input",
      'return _G["workflow"]',
      'return review_draft("x") -- comment\nend',
    ]) {
      expect(() => linkLuaReview({ module, caller: bad, identity })).toThrow();
    }
    expect(() => bindLuaReviewBoundary(module, [])).toThrow("Effect not granted");
    expect(() =>
      linkLuaReview({
        module: { ...module, sexpressions: "(define (review input) (while #t input))" },
        caller,
        identity,
      }),
    ).toThrow(/Unsupported Lua workflow IR|Invalid workflow module/);
    const artifact = linkLuaReview({ module, caller, identity });
    const kernel = createLuaKernel(runtime, {
      loadModule,
      decodeRequest: bindLuaReviewBoundary(module, allowed),
      decodeResult: (value) => value,
    });
    await runtime.start(function* () {
      const recipe = yield* kernel.prepare(artifact.source, "draft");
      const guest = yield* recipe.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      yield* guest.start();
      const state = yield* recipe.checkpoints.capture(guest);
      for (const changed of [
        linkLuaReview({ module, caller: caller.replace("caller:", "edited:"), identity }),
        linkLuaReview({
          module: {
            ...module,
            effects: Object.fromEntries(
              Object.entries(module.effects).map(([site, effect]) => [
                site,
                { ...effect, source: { ...effect.source, line: 999 } },
              ]),
            ),
          },
          caller,
          identity,
        }),
      ]) {
        expect(changed.program).not.toBe(artifact.program);
        const wrong = yield* kernel.prepare(changed.source, "draft");
        const failure = yield* runtime.composition.catchError(
          () => wrong.checkpoints.restore(state),
          function* (error) {
            return String(error);
          },
        );
        expect(failure).toMatch(/mismatch|identity/i);
      }
    }).result;
  });
});
