import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { run } from "effection";
import { schemeWorkflowCompiler as workflowCompiler } from "../../../../packages/flowmode-compiler-scheme/dist/index.js";
import { loadMachine } from "../../hoot-composition/machine.mjs";
import { encodeValue } from "../../../../packages/flowmode-compiler/dist/scheme-data/values.js";
import { luaWorkflowCompiler } from "../../../../packages/flowmode-compiler-lua/dist/index.js";
import { createLuaAuthoring } from "../../teal-lua-checkpoint/authoring.mts";
import { createLuaKernel, createLuaProgramBundle } from "../../teal-lua-checkpoint/kernel.mts";
import { invokeWasm } from "../../teal-lua-checkpoint/wasm-node.mts";
import {
  reviewExports,
  reviewImports,
  reviewContract,
  callerContract,
} from "../../tsdown-authoring/contracts.mts";
import { requireCompiledWorkflow } from "../../../../packages/flowmode-runtime/dist/index.js";

const source = await readFile(
  new URL("../../../../apps/yo-workflow/execution/review-draft.workflow.ts", import.meta.url),
  "utf8",
);

// Mechanical preparation only. Tests below drive and assert every execution boundary.
async function prepare(text = source, sourceId = "review-draft.workflow.ts") {
  return run(function* () {
    const module = requireCompiledWorkflow(
      yield* luaWorkflowCompiler.compile({
        source: { id: sourceId, language: "typescript", text },
        entry: "review_draft",
        exports: reviewExports,
        bindings: reviewImports,
      }),
    );
    const { luaCompiler, luaLinker } = createLuaAuthoring(invokeWasm);
    const bindings = [
      { kind: "compiled", contract: reviewContract, module, export: "reviewDraft" },
      ...reviewImports.map((d) => ({ ...d, capability: { name: "elicit", version: "1" } })),
    ];
    const caller = requireCompiledWorkflow(
      yield* luaCompiler.compile({
        source: {
          id: "caller.lua",
          language: "lua",
          text: "local answer = review_draft(input)\nreturn {answer = answer, title = input.title}",
        },
        entry: "workflow",
        exports: [{ name: "workflow", entry: "workflow", contract: callerContract }],
        bindings: bindings.map(({ kind, contract }) => ({ kind, contract })),
      }),
    );
    const linked = yield* luaLinker.link({ caller, bindings });
    const bundle = createLuaProgramBundle(linked.payload, {
      programId: "typescript-lua-spike",
      version: "1",
      inputSchema: callerContract.inputSchema,
      outputSchema: callerContract.outputSchema,
      effects: {},
      elicits: {
        approval: { response: reviewContract.outputSchema },
        cleanup: { response: reviewContract.outputSchema },
      },
      capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
    });
    return { module, program: bundle.artifact };
  });
}

const compiled = await prepare();
const evidence = new URL("../../../../.artifacts/lua-compiler/", import.meta.url);
await mkdir(evidence, { recursive: true });
await writeFile(new URL("review-draft.lua", evidence), compiled.module.implementation.payload);
await writeFile(new URL("program.json", evidence), JSON.stringify(compiled.program, null, 2));

for (const choice of ["approve", "decline", "throw", "cancel"]) {
  test(`TypeScript → Lua/Wasm: ${choice}, restore at approval and yielding scope cleanup`, async () => {
    await run(function* () {
      let kernel = createLuaKernel(invokeWasm);
      try {
        let live = yield* kernel.start(compiled.program, {
          title: 'Review "café" 🐈\nnow',
          recipient: "Sam",
          metadata: null,
        });
        assert.equal(live.boundary.kind, "suspended");
        assert.equal(live.boundary.request.binding, '["elicit","approval"]');
        assert.equal(live.boundary.request.input.message, 'Review "café" 🐈\nnow');
        const pending = live.boundary.request;
        const snapshot = JSON.parse(JSON.stringify(yield* live.execution.capture()));
        yield* live.execution.dispose();
        yield* kernel.close();
        kernel = createLuaKernel(invokeWasm);
        live = yield* kernel.restore(compiled.program, snapshot);
        assert.deepEqual(live.boundary.request, pending);
        assert.deepEqual(
          (yield* live.execution.capture()).state,
          snapshot.state,
          "restore does not advance guest state",
        );

        const cleanup =
          choice === "cancel"
            ? yield* live.execution.cancel("stop")
            : yield* live.execution.resume(
                live.boundary.suspensionId,
                choice === "throw"
                  ? { kind: "throw", value: "approval unavailable" }
                  : {
                      kind: "value",
                      value: { action: "accept", content: { approved: choice === "approve" } },
                    },
              );
        assert.equal(cleanup.kind, "suspended");
        assert.equal(cleanup.request.binding, '["elicit","cleanup"]');
        const savedCleanup = JSON.parse(JSON.stringify(yield* live.execution.capture()));
        yield* live.execution.dispose();
        yield* kernel.close();
        kernel = createLuaKernel(invokeWasm);
        live = yield* kernel.restore(compiled.program, savedCleanup);
        assert.deepEqual(live.boundary.request, cleanup.request);
        assert.deepEqual((yield* live.execution.capture()).state, savedCleanup.state);
        if (choice === "cancel") {
          assert.deepEqual(
            yield* live.execution.cancel("again"),
            live.boundary,
            "repeated cancellation preserves cleanup",
          );
        }
        const terminal = yield* live.execution.resume(live.boundary.suspensionId, {
          kind: "value",
          value: null,
        });
        if (choice === "cancel") {
          assert.equal(terminal.kind, "cancelled");
        } else if (choice === "throw") {
          assert.equal(terminal.kind, "failed");
          assert.match(JSON.stringify(terminal.error), /approval unavailable/);
        } else {
          assert.deepEqual(terminal, {
            kind: "completed",
            value: {
              answer: choice === "approve" ? "Draft approved" : "Draft declined",
              title: 'Review "café" 🐈\nnow',
            },
          });
        }
      } finally {
        yield* kernel.close();
      }
    });
  });
}

test("compiled cleanup failure supersedes a pending return after restore", async () => {
  const { program } = await prepare(
    source.replace(
      'yield* ctx.elicit("cleanup", { message: "Release the draft reservation?" });',
      'yield* ctx.elicit("cleanup", { message: "Release the draft reservation?" }); throw "cleanup failed";',
    ),
  );
  await run(function* () {
    let kernel = createLuaKernel(invokeWasm);
    try {
      let live = yield* kernel.start(program, {
        title: "Review",
        recipient: "Sam",
        metadata: null,
      });
      const cleanup = yield* live.execution.resume(live.boundary.suspensionId, {
        kind: "value",
        value: { action: "accept", content: { approved: true } },
      });
      assert.equal(cleanup.request.binding, '["elicit","cleanup"]');
      const snapshot = JSON.parse(JSON.stringify(yield* live.execution.capture()));
      yield* kernel.close();
      kernel = createLuaKernel(invokeWasm);
      live = yield* kernel.restore(program, snapshot);
      const terminal = yield* live.execution.resume(live.boundary.suspensionId, {
        kind: "value",
        value: null,
      });
      assert.equal(terminal.kind, "failed");
      assert.match(JSON.stringify(terminal.error), /cleanup failed/);
    } finally {
      yield* kernel.close();
    }
  });
});

test("Lua preserves JS empty-string truthiness and cleanup's captured Unicode string", async () => {
  const text = source
    .replace(
      "yield* ensure(function* () {",
      "const reservation = input.recipient;\n  yield* ensure(function* () {",
    )
    .replace('message: "Release the draft reservation?"', "message: reservation")
    .replace("if (answer.content.approved)", "if (input.title)");
  const { program } = await prepare(text);
  await run(function* () {
    let kernel = createLuaKernel(invokeWasm);
    try {
      let live = yield* kernel.start(program, {
        title: "",
        recipient: "Release café 🐈\nreservation",
        metadata: null,
      });
      const snapshot = JSON.parse(JSON.stringify(yield* live.execution.capture()));
      yield* kernel.close();
      kernel = createLuaKernel(invokeWasm);
      live = yield* kernel.restore(program, snapshot);
      const cleanup = yield* live.execution.resume(live.boundary.suspensionId, {
        kind: "value",
        value: { action: "accept", content: { approved: true } },
      });
      assert.equal(cleanup.request.input.message, "Release café 🐈\nreservation");
      const savedCleanup = JSON.parse(JSON.stringify(yield* live.execution.capture()));
      yield* kernel.close();
      kernel = createLuaKernel(invokeWasm);
      live = yield* kernel.restore(program, savedCleanup);
      assert.deepEqual(live.boundary.request, cleanup.request);
      assert.deepEqual((yield* live.execution.capture()).state, savedCleanup.state);
      const terminal = yield* live.execution.resume(live.boundary.suspensionId, {
        kind: "value",
        value: null,
      });
      assert.deepEqual(terminal, {
        kind: "completed",
        value: { answer: "Draft declined", title: "" },
      });
    } finally {
      yield* kernel.close();
    }
  });
});

for (const [condition, expected] of [
  ["input.metadata", "Draft declined"],
  ["!input.metadata", "Draft approved"],
  ["input.metadata === null", "Draft approved"],
]) {
  test(`decoded JSON null preserves JavaScript semantics for ${condition}`, async () => {
    const { program } = await prepare(
      source.replace("if (answer.content.approved)", `if (${condition})`),
    );
    await run(function* () {
      const kernel = createLuaKernel(invokeWasm);
      try {
        const live = yield* kernel.start(program, {
          title: "Review",
          recipient: "Sam",
          metadata: null,
        });
        const cleanup = yield* live.execution.resume(live.boundary.suspensionId, {
          kind: "value",
          value: { action: "accept", content: { approved: true } },
        });
        assert.equal(cleanup.request.binding, '["elicit","cleanup"]');
        const terminal = yield* live.execution.resume(cleanup.suspensionId, {
          kind: "value",
          value: null,
        });
        assert.deepEqual(terminal, {
          kind: "completed",
          value: { answer: expected, title: "Review" },
        });
      } finally {
        yield* kernel.close();
      }
    });
  });
}

test("the Scheme target preserves a captured cleanup closure in fresh Hoot instances", async () => {
  const text = source
    .replace(
      "yield* ensure(function* () {",
      "const reservation = input.recipient;\n  yield* ensure(function* () {",
    )
    .replace('message: "Release the draft reservation?"', "message: reservation")
    .replace("if (answer.content.approved)", "if (input.title)");
  const module = await run(function* () {
    return requireCompiledWorkflow(
      yield* workflowCompiler.compile({
        source: { id: "review-draft.workflow.ts", language: "typescript", text },
        entry: "review_draft",
        exports: reviewExports,
        bindings: reviewImports,
      }),
    );
  });
  if (typeof module.implementation.payload !== "string") {
    assert.fail("Scheme compiler must emit source text");
  }
  const program =
    module.implementation.payload +
    `\n(review_draft #f (quote ${encodeValue({ title: "", recipient: "Release café 🐈\nreservation", metadata: null })}))`;
  let machine = await loadMachine();
  const approval = machine.start(program);
  assert.deepEqual(approval.value, ["elicit", "approval", ""]);
  const snapshot = JSON.parse(JSON.stringify(machine.capture()));
  machine = null;
  machine = await loadMachine();
  assert.deepEqual(machine.restore(program, snapshot), approval);
  assert.equal(machine.capture(), snapshot, "restore does not execute guest instructions");
  const cleanup = machine.resume({ action: "accept", content: { approved: true } });
  assert.deepEqual(cleanup.value, ["elicit", "cleanup", "Release café 🐈\nreservation"]);
  const savedCleanup = JSON.parse(JSON.stringify(machine.capture()));
  machine = null;
  machine = await loadMachine();
  assert.deepEqual(machine.restore(program, savedCleanup), cleanup);
  assert.equal(machine.capture(), savedCleanup);
  assert.deepEqual(machine.resume(null), { kind: "returned", site: "", value: "Draft declined" });
});

const closureSource = source
  .replace(
    'const answer = yield* ctx.elicit("approval", { message: input.title });',
    "const answer = yield* askReview();",
  )
  .replace('message: "Release the draft reservation?"', 'message: caption(":" + advance(8))')
  .replace(
    "yield* ensure(function* () {",
    `let count = 1;
  const advance = (delta: number): number => { count = count + delta; return count; };
  const makeCaption = (title: string) => (suffix: string) => title + suffix;
  const caption = makeCaption(input.title);
  const askReview = function* (): Operation<Reply> {
    const reply = yield* ctx.elicit("approval", { message: caption(":" + advance(2)) });
    advance(4);
    return reply;
  };
  yield* ensure(function* () {`,
  );

for (const completion of ["value", "throw", "cancel"]) {
  test(`Lua restores nested calls and shared mutable captures through ${completion}`, async () => {
    const { program } = await prepare(closureSource);
    await run(function* () {
      let kernel = createLuaKernel(invokeWasm);
      try {
        let live = yield* kernel.start(program, {
          title: "draft",
          recipient: "Sam",
          metadata: null,
        });
        assert.equal(live.boundary.request.input.message, "draft:3");
        const saved = JSON.parse(JSON.stringify(yield* live.execution.capture()));
        yield* live.execution.dispose();
        yield* kernel.close();
        kernel = createLuaKernel(invokeWasm);
        live = yield* kernel.restore(program, saved);
        assert.deepEqual((yield* live.execution.capture()).state, saved.state);
        const cleanup =
          completion === "cancel"
            ? yield* live.execution.cancel("stop")
            : yield* live.execution.resume(
                live.boundary.suspensionId,
                completion === "throw"
                  ? { kind: "throw", value: "approval failed" }
                  : { kind: "value", value: { action: "accept", content: { approved: true } } },
              );
        assert.equal(
          cleanup.request.input.message,
          completion === "value" ? "draft:15" : "draft:11",
        );
        const savedCleanup = JSON.parse(JSON.stringify(yield* live.execution.capture()));
        yield* live.execution.dispose();
        yield* kernel.close();
        kernel = createLuaKernel(invokeWasm);
        live = yield* kernel.restore(program, savedCleanup);
        assert.deepEqual(live.boundary.request, cleanup.request);
        assert.deepEqual((yield* live.execution.capture()).state, savedCleanup.state);
        if (completion === "cancel") {
          assert.deepEqual(yield* live.execution.cancel("again"), live.boundary);
        }
        const terminal = yield* live.execution.resume(live.boundary.suspensionId, {
          kind: "value",
          value: null,
        });
        if (completion === "value") {
          assert.deepEqual(terminal, {
            kind: "completed",
            value: { answer: "Draft approved", title: "draft" },
          });
        } else if (completion === "throw") {
          assert.equal(terminal.kind, "failed");
          assert.match(JSON.stringify(terminal.error), /approval failed/);
        } else {
          assert.equal(terminal.kind, "cancelled");
        }
      } finally {
        yield* kernel.close();
      }
    });
  });

  test(`Hoot restores nested calls and shared mutable captures through ${completion}`, async () => {
    const module = await run(function* () {
      return requireCompiledWorkflow(
        yield* workflowCompiler.compile({
          source: { id: "review-draft.workflow.ts", language: "typescript", text: closureSource },
          entry: "review_draft",
          exports: reviewExports,
          bindings: reviewImports,
        }),
      );
    });
    if (typeof module.implementation.payload !== "string") {
      throw Error("Expected Scheme source");
    }
    const program =
      module.implementation.payload +
      `\n(review_draft #f (quote ${encodeValue({ title: "draft", recipient: "Sam", metadata: null })}))`;
    let machine = await loadMachine();
    const approval = machine.start(program);
    assert.deepEqual(approval.value, ["elicit", "approval", "draft:3"]);
    const saved = machine.capture();
    machine = null;
    machine = await loadMachine();
    assert.deepEqual(machine.restore(program, saved), approval);
    assert.equal(machine.capture(), saved);
    const cleanup =
      completion === "cancel"
        ? machine.cancel()
        : completion === "throw"
          ? machine.reject("approval failed")
          : machine.resume({ action: "accept", content: { approved: true } });
    assert.deepEqual(cleanup.value, [
      "elicit",
      "cleanup",
      completion === "value" ? "draft:15" : "draft:11",
    ]);
    const savedCleanup = machine.capture();
    machine = null;
    machine = await loadMachine();
    assert.deepEqual(machine.restore(program, savedCleanup), cleanup);
    assert.equal(machine.capture(), savedCleanup);
    if (completion === "cancel") {
      assert.deepEqual(machine.cancel(), cleanup);
    }
    assert.deepEqual(machine.resume(null), {
      kind: completion === "value" ? "returned" : completion === "throw" ? "thrown" : "cancelled",
      site: "",
      value:
        completion === "value"
          ? "Draft approved"
          : completion === "throw"
            ? "approval failed"
            : false,
    });
  });
}

const importedDirectory = new URL(
  "../../../../apps/yo-workflow/.artifacts/imported-runtime/",
  import.meta.url,
);
await mkdir(importedDirectory, { recursive: true });
await writeFile(
  new URL("helpers.ts", importedDirectory),
  `
import { ensure as release, type Operation } from "effection";
export function* register(ctx: { elicit(key: "approval" | "cleanup", request: { message: string }): Operation<unknown> }): Operation<(delta: number) => number> {
  let count = 0;
  const advance = (delta: number): number => { count = count + delta; return count; };
  yield* release(function* () { yield* ctx.elicit("cleanup", { message: "helper:" + count }); });
  return advance;
}
export function label(value: string) { return value + ":"; }
`,
);
const importedId = fileURLToPath(new URL("review.workflow.ts", importedDirectory));
const importedSource =
  'import { register, label as caption } from "./helpers.ts";\n' +
  source
    .replace(
      "yield* ensure(function* () {",
      "const advance = yield* register(ctx);\n  yield* ensure(function* () {",
    )
    .replace('message: "Release the draft reservation?"', 'message: "root:" + advance(0)')
    .replace("message: input.title", "message: caption(input.title) + advance(2)")
    .replace("if (answer.action", "advance(4);\n  if (answer.action");

for (const completion of ["value", "cancel"]) {
  test(`imported Lua helpers share captures and caller cleanup scope through ${completion}`, async () => {
    const { program } = await prepare(importedSource, importedId);
    await run(function* () {
      let kernel = createLuaKernel(invokeWasm);
      try {
        let live = yield* kernel.start(program, {
          title: "draft",
          recipient: "Sam",
          metadata: null,
        });
        // The helper returned before this effect: its ensure must still be pending.
        assert.equal(live.boundary.request.binding, '["elicit","approval"]');
        assert.equal(live.boundary.request.input.message, "draft:2");
        const snapshot = JSON.parse(JSON.stringify(yield* live.execution.capture()));
        yield* kernel.close();
        kernel = createLuaKernel(invokeWasm);
        live = yield* kernel.restore(program, snapshot);
        assert.deepEqual((yield* live.execution.capture()).state, snapshot.state);
        const cleanup =
          completion === "cancel"
            ? yield* live.execution.cancel("stop")
            : yield* live.execution.resume(live.boundary.suspensionId, {
                kind: "value",
                value: { action: "accept", content: { approved: true } },
              });
        assert.equal(cleanup.request.input.message, completion === "cancel" ? "root:2" : "root:6");
        const saved = JSON.parse(JSON.stringify(yield* live.execution.capture()));
        yield* kernel.close();
        kernel = createLuaKernel(invokeWasm);
        live = yield* kernel.restore(program, saved);
        assert.deepEqual(live.boundary.request, cleanup.request);
        if (completion === "cancel") {
          assert.deepEqual(yield* live.execution.cancel("again"), live.boundary);
        }
        const helperCleanup = yield* live.execution.resume(live.boundary.suspensionId, {
          kind: "value",
          value: null,
        });
        assert.equal(
          helperCleanup.request.input.message,
          completion === "cancel" ? "helper:2" : "helper:6",
        );
        const terminal = yield* live.execution.resume(helperCleanup.suspensionId, {
          kind: "value",
          value: null,
        });
        assert.equal(terminal.kind, completion === "cancel" ? "cancelled" : "completed");
        if (completion === "value") {
          assert.equal(terminal.value.answer, "Draft approved");
        }
      } finally {
        yield* kernel.close();
      }
    });
  });

  test(`imported Scheme helpers share captures and caller cleanup scope through ${completion}`, async () => {
    const module = await run(function* () {
      return requireCompiledWorkflow(
        yield* workflowCompiler.compile({
          source: { id: importedId, language: "typescript", text: importedSource },
          entry: "review_draft",
          exports: reviewExports,
          bindings: reviewImports,
        }),
      );
    });
    const program =
      module.implementation.payload +
      `\n(review_draft #f (quote ${encodeValue({ title: "draft", recipient: "Sam", metadata: null })}))`;
    let machine = await loadMachine();
    const approval = machine.start(program);
    assert.deepEqual(approval.value, ["elicit", "approval", "draft:2"]);
    const snapshot = machine.capture();
    machine = await loadMachine();
    assert.deepEqual(machine.restore(program, snapshot), approval);
    assert.equal(machine.capture(), snapshot);
    const cleanup =
      completion === "cancel"
        ? machine.cancel()
        : machine.resume({ action: "accept", content: { approved: true } });
    assert.deepEqual(cleanup.value, [
      "elicit",
      "cleanup",
      completion === "cancel" ? "root:2" : "root:6",
    ]);
    const saved = machine.capture();
    machine = await loadMachine();
    assert.deepEqual(machine.restore(program, saved), cleanup);
    if (completion === "cancel") {
      assert.deepEqual(machine.cancel(), cleanup);
    }
    assert.deepEqual(machine.resume(null).value, [
      "elicit",
      "cleanup",
      completion === "cancel" ? "helper:2" : "helper:6",
    ]);
    const terminal = machine.resume(null);
    assert.equal(terminal.kind, completion === "cancel" ? "cancelled" : "returned");
    if (completion === "value") {
      assert.equal(terminal.value, "Draft approved");
    }
  });
}

test("a changed imported helper changes executable identity and rejects the previous snapshot", async () => {
  const { program } = await prepare(importedSource, importedId);
  const helpers = new URL("helpers.ts", importedDirectory);
  const original = await readFile(helpers, "utf8");
  await writeFile(helpers, original.replace('return value + ":"', 'return value + "!"'));
  let changed;
  try {
    changed = await prepare(importedSource, importedId);
  } finally {
    await writeFile(helpers, original);
  }
  assert.notEqual(changed.program.digest, program.digest);
  await run(function* () {
    const kernel = createLuaKernel(invokeWasm);
    try {
      const live = yield* kernel.start(program, {
        title: "draft",
        recipient: "Sam",
        metadata: null,
      });
      const snapshot = yield* live.execution.capture();
      let rejected = false;
      try {
        yield* kernel.restore(changed.program, snapshot);
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true, "changed helper cannot restore the old program");
    } finally {
      yield* kernel.close();
    }
  });
});

// A rewrite of the shared Scheme IR must control both kernels. In Scheme, zero
// is true; the TS frontend explicitly inserts truthy to implement JS semantics.
test("both kernels execute Scheme truthiness after a shared IR rewrite", async () => {
  const { lowerWorkflow, emitSchemeIR } =
    await import("../../../../packages/flowmode-compiler/dist/index.js");
  const { luaWorkflowTarget } =
    await import("../../../../packages/flowmode-compiler-lua/dist/index.js");
  for (const negate of [false, true]) {
    for (const stripCoercion of [false, true]) {
      const program = lowerWorkflow(
        `function* workflow(ctx, input) { "use workflow"; if (${negate ? "!0" : "0"}) { return "yes"; } return "no"; }`,
        { allowFinally: true, entryInput: true, entryPoint: null },
      );
      const branch = program.functions[0].body.statements[0];
      assert.equal(branch.kind, "if");
      assert.equal(branch.test.kind, "truthy");
      if (stripCoercion) {
        // Keep Scheme not if present, but remove JS truthiness conversion.
        branch.test = branch.test.value;
        if (negate) {
          assert.equal(branch.test.kind, "not");
          assert.equal(branch.test.value.kind, "truthy");
          branch.test.value = branch.test.value.value;
        }
      }
      const expected = stripCoercion !== negate ? "yes" : "no";
      const scheme = emitSchemeIR(program).payload + "\n(workflow #f (object))";
      const machine = await loadMachine();
      assert.deepEqual(machine.start(scheme), { kind: "returned", site: "", value: expected });
      const lua = luaWorkflowTarget.emit(program, [
        { name: "workflow", entry: "workflow" },
      ]).payload;
      const bundle = createLuaProgramBundle(`return (function()\n${lua}\nend)()(input)`, {
        programId: "scheme-ir-truthiness",
        version: "1",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "string" },
        effects: {},
        elicits: {},
        capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
      });
      await run(function* () {
        const kernel = createLuaKernel(invokeWasm);
        try {
          const live = yield* kernel.start(bundle.artifact, {});
          assert.deepEqual(live.boundary, { kind: "completed", value: expected });
          yield* live.execution.dispose();
        } finally {
          yield* kernel.close();
        }
      });
    }
  }
});
