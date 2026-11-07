import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSchemeKernel } from "@sweatpan.ts/codemode-runtime-scheme";
import {
  loadSchemeMachine,
  schemeRuntimeIdentity,
} from "@sweatpan.ts/codemode-runtime-scheme/node";
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
  bindEffectBoundary,
} from "../../../../../experiments/workflow-kernel/scriptc-scheme/workflow.mjs";
import { effects } from "../../../../../experiments/workflow-kernel/scriptc-scheme/contract.mts";
import {
  linkReview,
  schemeWorkflowLinker,
  inspectLinkedCheckpoint,
  type LinkedCapture,
} from "../../../../../experiments/workflow-kernel/scriptc-scheme/linked.mjs";
import { createLinkedExecution } from "../../../../../experiments/workflow-kernel/scriptc-scheme/cloudflare/execution.mts";
import { forEachRuntime } from "../runtime/assembly.ts";

const caller = `(define (workflow input)
  (let ((answer (review_draft input)))
    (if (equal? answer "approved:yes")
      (string-append "caller:" answer)
      "caller:declined")))
(workflow %input)`;
const allowed = Object.values(effects).map((effect) => effect.id);

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const approved of [true, false]) {
    it(`${runtime.name}: authored TypeScript Outcome branch ${approved} runs in scheme across restore and cleanup`, async () => {
      const module = await runtime.start(() => outcomeFrontend.lower(outcomeInput)).result;
      const artifact = schemeWorkflowLinker.link({
        module,
        caller: { language: "scheme", text: "(review_draft %input)" },
        name: "review_draft",
        identity: schemeRuntimeIdentity,
      });
      await runtime.start(function* () {
        const recipe = yield* createSchemeKernel(runtime, {
          identity: schemeRuntimeIdentity,
          loadMachine: loadSchemeMachine,
          decodeRequest: bindEffectBoundary(module, allowed),
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

  it(`${runtime.name}: scheme raw effect preserves domain success and rejection as data across restore`, async () => {
    const base = await runtime.start(() => frontend.lower(input)).result;
    const site = Object.keys(base.effects)[0]!;
    const effect = base.effects[site]!;
    // No authoring unwrap: the exact same effect boundary can expose Outcome data.
    const module = {
      ...base,
      sexpressions: `(define (review input) (workflow-return (yield-at ${JSON.stringify(site)} (list "effect" ${JSON.stringify(effect.effect)} input))))`,
    };
    const artifact = schemeWorkflowLinker.link({
      module,
      caller: { language: "scheme", text: "(review_draft %input)" },
      name: "review_draft",
      identity: schemeRuntimeIdentity,
    });
    for (const outcome of [
      { ok: true, value: "yes" },
      { ok: false, error: "declined" },
    ]) {
      await runtime.start(function* () {
        const recipe = yield* createSchemeKernel(runtime, {
          identity: schemeRuntimeIdentity,
          loadMachine: loadSchemeMachine,
          decodeRequest: bindEffectBoundary(module, allowed),
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

  it(`${runtime.name}: scheme linker rejects unsupported caller language and binding`, async () => {
    const module = await runtime.start(() => frontend.lower(input)).result;
    const request = {
      module,
      caller: { language: "scheme", text: caller },
      name: "review_draft",
      identity: "test-runtime",
    };
    expect(() =>
      schemeWorkflowLinker.link({ ...request, caller: { ...request.caller, language: "python" } }),
    ).toThrow();
    expect(() => schemeWorkflowLinker.link({ ...request, name: "if" })).toThrow();
    const linked = schemeWorkflowLinker.link(request);
    expect(linked).toMatchObject({
      language: "scheme",
      name: "review_draft",
      entry: module.entry.name,
      effects: module.effects,
    });
    expect(schemeWorkflowLinker.link({ ...request, identity: "another-runtime" }).program).not.toBe(
      linked.program,
    );
  });

  for (const choice of ["approve", "decline", "cancel-body", "cancel-cleanup"] as const) {
    it(`${runtime.name}: linked developer workflow ${choice} is inspectable across journal reopen`, async () => {
      const module = await runtime.start(() => frontend.lower(input)).result;
      const artifact = schemeWorkflowLinker.link({
        module,
        caller: { language: "scheme", text: caller },
        name: "review_draft",
        identity: schemeRuntimeIdentity,
      });
      const store = createSqliteJournalRig<string, CapabilityRequest, unknown, unknown, unknown, Y>(
        {
          program: artifact.program,
          equals: isDeepStrictEqual,
        },
      );
      onTestFinished(() => store.close());
      let loads = 0;
      let starts = 0;
      let restores = 0;
      // Application diagnostics are separate from the journal's recovery checkpoint.
      // Retain a detached capture only after its wait was successfully published.
      let diagnostic: { revision: number; capture: LinkedCapture } | undefined;
      let running = false;
      const kernel = createSchemeKernel(runtime, {
        identity: schemeRuntimeIdentity,
        loadMachine() {
          loads++;
          return loadSchemeMachine();
        },
        decodeRequest: bindEffectBoundary(module, allowed),
        decodeResult: (value) => z.string().parse(value),
      });
      async function run(
        command?: { answer: ResolutionGrant; value: unknown } | { cancel: string },
      ) {
        if (running) {
          throw new Error("Linked command already running");
        }
        running = true;
        try {
          return await runtime.start(function* () {
            const recipe = yield* kernel.prepare(artifact.source, "draft");
            const journal = store.open();
            let observed: { request: CapabilityRequest; capture: LinkedCapture } | undefined;
            const recovery = createRecovery(runtime.composition, {
              name: "linked-review",
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
            yield* recovery.around(
              {
                *recover(args, next) {
                  const recovered = yield* next(...args);
                  observed =
                    recovered.turn.kind === "suspended"
                      ? {
                          request: recovered.turn.request,
                          capture: {
                            program: artifact.program,
                            state: yield* recipe.checkpoints.capture(recovered.guest),
                          },
                        }
                      : undefined;
                  return recovered;
                },
              },
              { at: "max" },
            );
            const grant = createEffectCapabilities(runtime, "linked-review-effects").grant(effects);
            const host = createHosting(runtime.composition, {
              name: "linked-review-host",
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
              const outcome = yield* grant.respond(request, { ok: true, value: command.value });
              yield* host.operations.answer(command.answer, { ok: true, value: outcome });
            } else if (command) {
              yield* host.operations.cancel(command.cancel, "stop");
            }
            const result = yield* host.operations.run();
            const published = yield* journal.read();
            diagnostic =
              published.status === "running" &&
              published.pending &&
              observed &&
              isDeepStrictEqual(published.pending.request, observed.request)
                ? { revision: published.revision, capture: structuredClone(observed.capture) }
                : undefined;
            return result;
          }).result;
        } finally {
          running = false;
        }
      }
      async function readCapture() {
        if (running) {
          throw new Error("Linked command already running");
        }
        const state = await runtime.start(() => store.open().read()).result;
        if (running) {
          throw new Error("Linked command already running");
        }
        const captured =
          state.checkpoint ??
          (diagnostic?.revision === state.revision ? diagnostic.capture : undefined);
        if (!captured) {
          throw new Error("No current checkpoint or diagnostic capture");
        }
        return { state, captured };
      }
      async function inspect(key: "approval" | "cleanup") {
        const { state, captured } = await readCapture();
        expect(state.status).toBe("running");
        if (state.cancellation) {
          expect(state.checkpoint).toBeUndefined();
        }
        const before = JSON.stringify(captured);
        const priorLoads = loads;
        const view = inspectLinkedCheckpoint(artifact, captured);
        expect(view.key).toBe(key);
        expect(view.source).toMatchObject({
          id: "review.workflow.ts",
          line: key === "approval" ? 9 : 13,
        });
        expect(view.calls).toContainEqual({ name: "workflow", kind: "caller" });
        expect(view.calls).toContainEqual({ name: "review_draft", kind: "compiled" });
        expect(view.truncated).toBe(false);
        // Inspection needs neither a VM nor a live Guest, and cannot advance acceptance.
        expect(inspectLinkedCheckpoint(artifact, captured)).toEqual(view);
        expect(loads).toBe(priorLoads);
        expect(JSON.stringify(captured)).toBe(before);
        expect(await runtime.start(() => store.open().read()).result.then((s) => s.revision)).toBe(
          state.revision,
        );
        // Physical restoration of this exact continuation leaves its evaluator state unchanged.
        await runtime.start(function* () {
          const recipe = yield* kernel.prepare(artifact.source, "draft");
          const restored = yield* recipe.checkpoints.restore(captured.state);
          yield* runtime.composition.ensure(() => restored.guest.close());
          const recaptured = yield* recipe.checkpoints.capture(restored.guest);
          expect(recaptured).toEqual(captured.state);
          expect(
            inspectLinkedCheckpoint(artifact, { program: artifact.program, state: recaptured }),
          ).toEqual(view);
        }).result;
        return view;
      }
      const pending = run();
      await expect(run()).rejects.toThrow("already running");
      await expect(readCapture()).rejects.toThrow("already running");
      const first = await pending;
      if (first.state !== "waiting") {
        throw new Error("Expected approval");
      }
      const approval = await inspect("approval");
      expect(approval.cleanup).toEqual([]);
      expect(approval.cancellationRequested).toBe(false);
      await expect(
        run({ answer: { ...first.grant, resolutionId: approval.site }, value: "yes" }),
      ).rejects.toThrow("Unknown resolution authority");
      await expect(run({ answer: first.grant, value: 42 })).rejects.toThrow(
        "Effect schema rejected value",
      );
      store.reopen();
      expect(await inspect("approval")).toEqual(approval);
      const second =
        choice === "cancel-body"
          ? await run({ cancel: first.grant.requestId })
          : await run({ answer: first.grant, value: choice === "decline" ? "no" : "yes" });
      if (second.state !== "waiting") {
        throw new Error("Expected cleanup");
      }
      const cleanup = await inspect("cleanup");
      expect(cleanup.cleanup).toContainEqual({
        kind: "after-finally",
        completion: choice === "cancel-body" ? "cancelled" : "returned",
      });
      expect(cleanup.steps).toBeGreaterThan(approval.steps);
      expect(
        await runtime.start(() => store.open().interactions.request(second.grant)).result,
      ).toEqual({
        effect: effects.cleanup.id,
        input: {
          message: `release:${choice === "cancel-body" ? "draft" : choice === "decline" ? "no" : "yes"}`,
        },
      });
      if (choice.startsWith("cancel")) {
        const again = await run({
          cancel: choice === "cancel-body" ? first.grant.requestId : second.grant.requestId,
        });
        expect(again).toMatchObject({ state: "waiting", grant: second.grant });
      }
      store.reopen();
      if (choice.startsWith("cancel")) {
        const savedDiagnostic = diagnostic;
        const priorLoads = loads;
        diagnostic = undefined;
        await expect(readCapture()).rejects.toThrow("No current checkpoint");
        diagnostic = { ...savedDiagnostic!, revision: -1 };
        await expect(readCapture()).rejects.toThrow("No current checkpoint");
        expect(loads).toBe(priorLoads);
        diagnostic = savedDiagnostic;
      }
      await inspect("cleanup");
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
      const before = { loads, starts, restores };
      await run();
      expect({ loads, starts, restores }).toEqual(before);
    });
  }

  it(`${runtime.name}: registered scope attributes colliding caller and private helper frames`, async () => {
    await runtime.start(function* () {
      const base = yield* frontend.lower(input);
      const module = {
        ...base,
        entry: { ...base.entry, name: "wrapper" },
        sexpressions: "(define (wrapper input) (review input))\n" + base.sexpressions,
      };
      const artifact = linkReview({
        module,
        caller: "(define (review input) (review_draft input)) (review %input)",
        identity: schemeRuntimeIdentity,
      });
      const kernel = createSchemeKernel(runtime, {
        identity: schemeRuntimeIdentity,
        loadMachine: loadSchemeMachine,
        decodeRequest: bindEffectBoundary(module, allowed),
        decodeResult: (value) => value,
      });
      const recipe = yield* kernel.prepare(artifact.source, "draft");
      const guest = yield* recipe.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      expect((yield* guest.start()).kind).toBe("suspended");
      const capture = {
        program: artifact.program,
        state: yield* recipe.checkpoints.capture(guest),
      };
      const view = inspectLinkedCheckpoint(artifact, capture);
      expect(view.calls).toEqual([
        { name: "review", kind: "caller" },
        { name: "review_draft", kind: "compiled" },
        { name: "review", kind: "compiled" },
      ]);
      const restored = yield* recipe.checkpoints.restore(capture.state);
      yield* runtime.composition.ensure(() => restored.guest.close());
      expect(
        inspectLinkedCheckpoint(artifact, {
          program: artifact.program,
          state: yield* recipe.checkpoints.capture(restored.guest),
        }),
      ).toEqual(view);
    }).result;
  });

  it(`${runtime.name}: linked caller rejects lossy numbers and preserves supported strings and integers`, async () => {
    await runtime.start(function* () {
      const module = yield* frontend.lower(input);
      for (const literal of ["1/2", "9007199254740993", "-9007199254740993", "0.5", "1e3", "-0"]) {
        expect(() =>
          linkReview({ module, caller: `(js-add ${literal} 1)`, identity: schemeRuntimeIdentity }),
        ).toThrow("Unsupported caller literal");
      }
      expect(() =>
        linkReview({
          module,
          caller: "(root %input)",
          name: "root",
          identity: schemeRuntimeIdentity,
        }),
      ).toThrow("profile");
      const artifact = linkReview({
        module,
        caller: String.raw`(review_draft (if (equal? 9007199254740991 9007199254740991) "actual\x1;\n\"draft\"" %input))`,
        identity: schemeRuntimeIdentity,
      });
      const recipe = yield* createSchemeKernel(runtime, {
        identity: schemeRuntimeIdentity,
        loadMachine: loadSchemeMachine,
        decodeRequest: bindEffectBoundary(module, allowed),
        decodeResult: (value) => value,
      }).prepare(artifact.source, "unused input");
      const guest = yield* recipe.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      expect(yield* guest.start()).toMatchObject({
        kind: "suspended",
        request: { input: { message: 'approve:actual\x01\n"draft"' } },
      });
    }).result;
  });

  it(`${runtime.name}: local demo derives approval and recovery controls from the journal after interruptions`, async () => {
    const module = await runtime.start(() => frontend.lower(input)).result;
    const artifact = linkReview({
      module,
      caller: '(define (workflow input) (review_draft "actual submitted draft")) (workflow %input)',
      identity: schemeRuntimeIdentity,
    });
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, unknown, unknown, Y>({
      program: artifact.program,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    let unavailable = true;
    let loads = 0;
    const counters = { starts: 0, restores: 0 };
    const assembly = () =>
      createLinkedExecution(runtime, {
        module,
        artifact,
        input: "original model input",
        journal: store.open(),
        counters,
        async loadMachine() {
          loads++;
          if (unavailable) {
            throw new Error("Loader temporarily unavailable");
          }
          return loadSchemeMachine();
        },
      });
    await expect(runtime.start(() => assembly().advance()).result).rejects.toThrow(
      "Loader temporarily unavailable",
    );
    store.reopen();
    const prior = loads;
    expect(await runtime.start(() => assembly().read()).result).toMatchObject({
      canAdvance: true,
      result: { state: "running" },
      question: null,
    });
    expect(loads).toBe(prior);
    unavailable = false;
    await runtime.start(() => assembly().advance()).result;
    store.reopen();
    const approval = await runtime.start(() => assembly().read()).result;
    expect(approval.question).toEqual({
      message: "approve:actual submitted draft",
      choices: [
        { label: "Approve draft", value: "yes" },
        { label: "Decline", value: "no" },
      ],
    });
    expect(approval.canAdvance).toBe(false);
    if (approval.result.state !== "waiting") {
      throw new Error("Expected approval");
    }
    // Acceptance commits, but the process stops before host advancement or any UI receipt write.
    const approvalGrant = approval.result.grant;
    await runtime.start(() =>
      store
        .open()
        .interactions.answer(approvalGrant, { ok: true, value: { ok: true, value: "yes" } }),
    ).result;
    store.reopen();
    const accepted = await runtime.start(() => assembly().read()).result;
    expect(accepted).toMatchObject({
      canAdvance: true,
      question: null,
      inspection: null,
      result: { state: "running" },
    });
    await runtime.start(() => assembly().advance()).result;
    store.reopen();
    const cleanup = await runtime.start(() => assembly().read()).result;
    expect(cleanup.question?.message).toBe("release:yes");
    if (cleanup.result.state !== "waiting") {
      throw new Error("Expected cleanup");
    }
    const cleanupGrant = cleanup.result.grant;
    await runtime.start(() => assembly().advance({ grant: cleanupGrant, value: "released" }))
      .result;
    store.reopen();
    const beforeRead = loads;
    expect(await runtime.start(() => assembly().read()).result).toMatchObject({
      canAdvance: false,
      question: null,
      inspection: null,
      result: { state: "completed", value: "approved:yes" },
    });
    expect(loads).toBe(beforeRead);
    expect(counters.restores).toBeGreaterThanOrEqual(2);
  });

  it(`${runtime.name}: explicit local advancement does not revive an invalidated question`, async () => {
    const module = await runtime.start(() => frontend.lower(input)).result;
    const artifact = linkReview({ module, caller, identity: schemeRuntimeIdentity });
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, unknown, unknown, Y>({
      program: artifact.program,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const assembly = () =>
      createLinkedExecution(runtime, {
        module,
        artifact,
        input: "draft",
        journal: store.open(),
        counters: { starts: 0, restores: 0 },
        loadMachine: loadSchemeMachine,
      });
    const first = await runtime.start(() => assembly().advance()).result;
    if (first.state !== "waiting") {
      throw new Error("Expected question");
    }
    await runtime.start(() => store.open().interactions.invalidate(first.grant, "withdrawn"))
      .result;
    store.reopen();
    expect(await runtime.start(() => assembly().read()).result).toMatchObject({
      canAdvance: false,
      question: null,
      result: { state: "invalidated", reason: "withdrawn" },
    });
    expect(await runtime.start(() => assembly().advance()).result).toMatchObject({
      state: "invalidated",
      reason: "withdrawn",
    });
    await expect(
      runtime.start(() => assembly().advance({ grant: first.grant, value: "yes" })).result,
    ).rejects.toThrow();
    expect(await runtime.start(() => assembly().read()).result).toMatchObject({
      question: null,
      result: { state: "invalidated" },
    });
  });

  it(`${runtime.name}: registered caller cannot enter private code or emit its internal effects`, async () => {
    await runtime.start(function* () {
      const module = yield* frontend.lower(input);
      for (const bad of [
        '(yield-at "forged" (list "effect" "scriptc.review.approval" "x"))',
        `(define (workflow input) (if #f (review_draft input) (yield-at "x" input))) (workflow %input)`,
        "(registered-program () () ())",
        "(quote (tool review_draft))",
      ]) {
        expect(() => linkReview({ module, caller: bad, identity: schemeRuntimeIdentity })).toThrow(
          /caller form/,
        );
      }
      expect(() => bindEffectBoundary(module, [effects.approval.id])).toThrow("Effect not granted");
      let requests = 0;
      for (const bad of [
        "(review %input)",
        "(approval %input)",
        "(define (review_draft input) input) (review_draft %input)",
        "(let ((review_draft (lambda (x) x))) (review_draft %input))",
      ]) {
        const artifact = linkReview({ module, caller: bad, identity: schemeRuntimeIdentity });
        const recipe = yield* createSchemeKernel(runtime, {
          identity: schemeRuntimeIdentity,
          loadMachine: loadSchemeMachine,
          decodeRequest(value) {
            requests++;
            return bindEffectBoundary(module, allowed)(value);
          },
          decodeResult: (value) => value,
        }).prepare(artifact.source, "draft");
        const guest = yield* recipe.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        const failure = yield* runtime.composition.catchError(
          () => guest.start(),
          function* (error) {
            return String(error);
          },
        );
        expect(failure).toMatch(/Unbound workflow identifier|Registered tool binding is immutable/);
      }
      expect(requests).toBe(0);
      const original = linkReview({ module, caller, identity: schemeRuntimeIdentity });
      const changed = linkReview({
        module,
        caller: caller.replace("caller:", "edited:"),
        identity: schemeRuntimeIdentity,
      });
      expect(changed.program).not.toBe(original.program);
      expect(() =>
        linkReview({ module, caller, name: "if", identity: schemeRuntimeIdentity }),
      ).toThrow(/profile/);
      const kernel = createSchemeKernel(runtime, {
        identity: schemeRuntimeIdentity,
        loadMachine: loadSchemeMachine,
        decodeRequest: bindEffectBoundary(module, allowed),
        decodeResult: (value) => value,
      });
      const recipe = yield* kernel.prepare(original.source, "draft");
      const guest = yield* recipe.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      yield* guest.start();
      const saved = { program: original.program, state: yield* recipe.checkpoints.capture(guest) };
      const observed = inspectLinkedCheckpoint(original, saved);
      observed.calls[0]!.name = "tampered";
      expect(inspectLinkedCheckpoint(original, saved).calls[0]!.name).not.toBe("tampered");
      expect(() => inspectLinkedCheckpoint(changed, saved)).toThrow(/does not match/);
      const remapped = linkReview({
        module: {
          ...module,
          effects: Object.fromEntries(
            Object.entries(module.effects).map(([site, effect]) => [
              site,
              {
                ...effect,
                source: { ...effect.source, id: "wrong.workflow.ts", line: 999 },
              },
            ]),
          ),
        },
        caller,
        identity: schemeRuntimeIdentity,
      });
      expect(remapped.source).toBe(original.source);
      expect(remapped.program).not.toBe(original.program);
      expect(() => inspectLinkedCheckpoint(remapped, saved)).toThrow(
        "Inspection program does not match",
      );
      const wrong = yield* kernel.prepare(changed.source, "draft");
      const rejection = yield* runtime.composition.catchError(
        () => wrong.checkpoints.restore(saved.state),
        function* (error) {
          return String(error);
        },
      );
      expect(rejection).toMatch(/source\/runtime mismatch/);
    }).result;
  });
});
