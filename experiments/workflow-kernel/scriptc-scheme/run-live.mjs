// Manual integration probe: ScriptC launches tsgo, so this is intentionally not
// part of the subprocess-free acceptance suite. No model or network calls.
import assert from "node:assert/strict";
import { createRuntime as createEffectRuntime } from "../../../packages/v2/runtime-effect/src/index.ts";
import { createRuntime as createEffectionRuntime } from "../../../packages/v2/runtime-effection/src/index.ts";
import { createSchemeKernel } from "../../../packages/v2/codemode-runtime-scheme/src/index.ts";
import {
  loadSchemeMachine,
  schemeRuntimeIdentity,
} from "../../../packages/v2/codemode-runtime-scheme/src/node.ts";
import { schemeWorkflowTarget } from "../../../packages/v2/codemode-compiler-scheme/src/index.ts";
import { frontend, compileWorkflow } from "./live.mjs";
import { input } from "./input.mjs";
import { bindEffectBoundary } from "./boundary.mts";
import { linkReview, inspectLinkedCheckpoint } from "./linked.mjs";

const edited = {
  ...input,
  source: { ...input.source, text: input.source.text.replace("'approved:'", "'published:'") },
  modules: { "helper.ts": input.modules["helper.ts"].replaceAll("prefix", "lead") },
};
let completed = 0;
for (const runtime of [createEffectRuntime(), createEffectionRuntime()]) {
  for (const [name, candidate, result] of [
    ["original", input, "approved:yes"],
    ["edited", edited, "published:yes"],
  ]) {
    for (const cancellation of ["none", "body", "cleanup"]) {
      await runtime.start(function* () {
        const module = yield* frontend.lower(candidate);
        const portable = JSON.parse(JSON.stringify(module));
        const artifact = schemeWorkflowTarget.emit(portable);
        assert.throws(() => bindEffectBoundary(portable, []), /Effect not granted/);
        const kernel = createSchemeKernel(runtime, {
          identity: schemeRuntimeIdentity,
          loadMachine: loadSchemeMachine,
          decodeRequest: bindEffectBoundary(portable, [
            "scriptc.review.approval",
            "scriptc.review.cleanup",
          ]),
          decodeResult: (value) => value,
        });
        const recipe = yield* kernel.prepare(artifact.source, "draft");
        const guest = yield* recipe.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        const first = yield* guest.start();
        assert.equal(first.kind, "suspended");
        assert.deepEqual(first.request, {
          effect: "scriptc.review.approval",
          input: { message: "approve:draft" },
        });
        const body = yield* recipe.checkpoints.capture(guest);
        yield* guest.close();
        const fresh = yield* kernel.prepare(artifact.source, "draft");
        const restored = yield* fresh.checkpoints.restore(body);
        yield* runtime.composition.ensure(() => restored.guest.close());
        let cleanup =
          cancellation === "body"
            ? yield* restored.guest.cancel("stop")
            : yield* restored.guest.resume({ ok: true, value: "yes" });
        assert.equal(cleanup.kind, "suspended");
        assert.equal(cleanup.scope.phase, "cleanup");
        assert.deepEqual(cleanup.request, {
          effect: "scriptc.review.cleanup",
          input: { message: cancellation === "body" ? "release:draft" : "release:yes" },
        });
        if (cancellation !== "none") {
          cleanup = yield* restored.guest.cancel("stop");
          assert.deepEqual(yield* restored.guest.cancel("again"), cleanup);
        }
        const checkpoint = yield* fresh.checkpoints.capture(restored.guest);
        yield* restored.guest.close();
        const next = yield* kernel.prepare(artifact.source, "draft");
        const final = yield* next.checkpoints.restore(checkpoint);
        yield* runtime.composition.ensure(() => final.guest.close());
        assert.deepEqual(final.turn, cleanup);
        assert.deepEqual(
          yield* final.guest.resume({ ok: true, value: "released" }),
          cancellation === "none"
            ? { kind: "completed", value: result }
            : { kind: "cancelled", reason: "stop", failure: undefined },
        );
      }).result;
      completed++;
      console.log(`${runtime.name}: ${name}, ${cancellation} — passed`);
    }
  }
}
// Live authored source also crosses the registered compiled-call boundary. This
// remains manual integration because ScriptC owns a subprocess.
for (const runtime of [createEffectRuntime(), createEffectionRuntime()]) {
  await runtime.start(function* () {
    const module = yield* frontend.lower(input);
    const artifact = linkReview({
      module,
      caller:
        '(define (workflow input) (string-append "caller:" (review_draft input))) (workflow %input)',
      identity: schemeRuntimeIdentity,
    });
    const kernel = createSchemeKernel(runtime, {
      identity: schemeRuntimeIdentity,
      loadMachine: loadSchemeMachine,
      decodeRequest: bindEffectBoundary(module, [
        "scriptc.review.approval",
        "scriptc.review.cleanup",
      ]),
      decodeResult: (value) => value,
    });
    const recipe = yield* kernel.prepare(artifact.source, "draft");
    const guest = yield* recipe.acquire();
    yield* runtime.composition.ensure(() => guest.close());
    assert.equal((yield* guest.start()).kind, "suspended");
    const captured = yield* recipe.checkpoints.capture(guest);
    const view = inspectLinkedCheckpoint(artifact, { program: artifact.program, state: captured });
    assert.equal(view.key, "approval");
    assert.ok(view.calls.some((call) => call.name === "review_draft" && call.kind === "compiled"));
    yield* guest.close();
    const fresh = yield* kernel.prepare(artifact.source, "draft");
    const restored = yield* fresh.checkpoints.restore(captured);
    yield* runtime.composition.ensure(() => restored.guest.close());
    assert.deepEqual(
      inspectLinkedCheckpoint(artifact, {
        program: artifact.program,
        state: yield* fresh.checkpoints.capture(restored.guest),
      }),
      view,
    );
    assert.equal((yield* restored.guest.resume({ ok: true, value: "yes" })).kind, "suspended");
    const cleanup = yield* fresh.checkpoints.capture(restored.guest);
    assert.equal(
      inspectLinkedCheckpoint(artifact, { program: artifact.program, state: cleanup }).key,
      "cleanup",
    );
    yield* restored.guest.close();
    const final = yield* fresh.checkpoints.restore(cleanup);
    yield* runtime.composition.ensure(() => final.guest.close());
    assert.deepEqual(yield* final.guest.resume({ ok: true, value: "released" }), {
      kind: "completed",
      value: "caller:approved:yes",
    });
  }).result;
  console.log(
    `${runtime.name}: live linked caller/compiled callee inspection and restore — passed`,
  );
}
assert.throws(
  () =>
    compileWorkflow({
      ...input,
      source: { ...input.source, text: input.source.text.replace("ctx.elicit", "ctx.sample") },
    }),
  /Workflow admission/,
);
assert.throws(
  () =>
    compileWorkflow({
      ...input,
      source: {
        ...input.source,
        text: input.source.text.replace(
          "message('approved:', decision)",
          "message('approved:', 42)",
        ),
      },
    }),
  /ScriptC.*rejected input/,
);
// Review regressions must fail before normalization can erase their evidence.
for (const text of [
  input.source.text.replace("title: string", "title: number"),
  input.source.text.replace("Operation<string>", "Operation<number>"),
  ...["globalThis?.process", "eval"].map((expression) =>
    input.source.text.replace(
      "  let reservation",
      `  const host = ${expression};\n  let reservation`,
    ),
  ),
]) {
  assert.throws(
    () => compileWorkflow({ ...input, source: { ...input.source, text } }),
    /Workflow admission/,
  );
}
assert.throws(
  () =>
    compileWorkflow({
      ...input,
      effects: { ...input.effects, approval: { ...input.effects.approval, response: undefined } },
    }),
  /unsupported declaration profile/,
);
// A failed frontend invocation must not prevent the next compilation.
assert.equal(compileWorkflow(input).module.format, "workflow-scheme/1");
console.log(
  `${completed} direct and 2 linked live compile/restore journeys and rejection recovery passed.`,
);
