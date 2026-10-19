import fs from "node:fs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { compileWorkflow } from "../compiled-frames/compiler.mjs";
import { compile, start, run } from "./engine.mjs";
const dir = fileURLToPath(new URL(".", import.meta.url));
const build = (source) => compileWorkflow(source, { compileScheme: compile, allowFinally: true });
if (process.argv[2] === "step") {
  const { artifact, state, options } = JSON.parse(fs.readFileSync(0, "utf8"));
  console.log(JSON.stringify({ ...run(artifact.program, state, options), pid: process.pid }));
} else {
  const base = fs.readFileSync(dir + "workflow.ts", "utf8");
  function fresh(artifact, state, options = {}) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "step"], {
      input: JSON.stringify({ artifact, state, options }),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  }
  const cases = [
    { name: "normal", source: base },
    { name: "body exception", source: base.replace("return answer;", 'throw "body failed";') },
    {
      name: "cleanup exception",
      source: base.replace('yield* ctx.elicit("child cleanup 2");', 'throw "cleanup failed";'),
    },
    {
      name: "cleanup replaces body error",
      source: base
        .replace("return answer;", 'throw "body failed";')
        .replace('yield* ctx.elicit("child cleanup 2");', 'throw "cleanup failed";'),
    },
    { name: "cleanup effect rejected", source: base, errorAt: "child cleanup 1" },
    { name: "effect rejected", source: base, errorAt: "body" },
    { name: "cancel body", source: base, cancelAt: "body" },
    { name: "cancel during natural cleanup", source: base, cancelAt: "child cleanup 1" },
    { name: "cancel parent continuation", source: base, cancelAt: "parent continued" },
    {
      name: "cancel nested cleanup",
      source: base.replace(
        'yield* ctx.elicit("child cleanup 1");',
        'try { yield* ctx.elicit("child cleanup 1"); } finally { yield* ctx.elicit("nested cleanup"); }',
      ),
      cancelAt: "nested cleanup",
    },
    {
      name: "lexical finally",
      source:
        'function* workflow(ctx) { "use workflow"; try { yield* ctx.elicit("body"); } finally { yield* ctx.elicit("cleanup"); } const after = yield* ctx.elicit("after block"); return after; }',
    },
  ];
  const results = [];
  for (const c of cases) {
    const artifact = build(c.source);
    let r = fresh(artifact, start(artifact.program));
    const trace = [],
      states = [],
      pids = [r.pid];
    let cancelled = false;
    for (let i = 0; i < 30 && r.state.status !== "done"; i++) {
      const label = r.effect[1];
      trace.push(label);
      states.push(r.state);
      if (label === c.cancelAt && !cancelled) {
        cancelled = true;
        const wasCleanup = r.state.frames.some((f) =>
          f.handlers.some((h) => h.phase === "cleanup"),
        );
        r = fresh(artifact, r.state, { cancel: true });
        pids.push(r.pid);
        if (wasCleanup) {
          assert.equal(r.waiting, true);
          assert.equal(r.effect[1], label);
          const repeated = fresh(artifact, r.state, { cancel: true });
          assert.deepEqual(repeated.state, r.state);
          r = fresh(artifact, r.state, { reply: "released" });
          pids.push(r.pid);
        }
      } else {
        r = fresh(
          artifact,
          r.state,
          label === c.errorAt
            ? { error: "host failure" }
            : { reply: label === "body" ? "answer" : "released" },
        );
        pids.push(r.pid);
      }
    }
    assert.equal(r.state.status, "done", c.name);
    assert.equal(new Set(pids).size, pids.length);
    if (!c.cancelAt) {
      const iter = vm.runInNewContext(c.source + "\nworkflow")({
        elicit: function* (label) {
          return yield ["elicit", label];
        },
      });
      const nativeTrace = [];
      let n = iter.next(),
        outcome;
      try {
        while (!n.done) {
          const label = n.value[1];
          nativeTrace.push(label);
          n =
            label === c.errorAt
              ? iter.throw("host failure")
              : iter.next(label === "body" ? "answer" : "released");
        }
        outcome = { kind: "returned", value: n.value };
      } catch (error) {
        outcome = { kind: "thrown", value: error };
      }
      assert.deepEqual(trace, nativeTrace, c.name);
      assert.deepEqual(r.outcome, JSON.parse(JSON.stringify(outcome)), c.name);
    } else {
      assert.deepEqual(r.outcome, { kind: "cancelled" }, c.name);
      if (c.cancelAt !== "parent continued") {
        assert.equal(trace.includes("parent continued"), false, c.name);
      }
      assert.equal(trace.at(-1), "parent cleanup");
      if (c.cancelAt !== "parent continued") {
        assert.ok(trace.includes("child cleanup 2"));
      }
    }
    if (c.name === "normal") {
      fs.writeFileSync(dir + "artifact.json", JSON.stringify(artifact, null, 2));
      fs.writeFileSync(dir + "checkpoint-cleanup.json", JSON.stringify(states[1], null, 2));
      const cleanup = states[1].frames.at(-1).handlers.findLast((h) => h.phase === "cleanup");
      assert.deepEqual(cleanup.pending, { kind: "returned", value: "answer" });
      const edited = build("// Source-only change\n" + c.source);
      assert.deepEqual(fresh(edited, states[1], { reply: "released" }).effect, [
        "elicit",
        "child cleanup 2",
      ]);
      const changed = build(c.source.replace("child cleanup 2", "changed cleanup"));
      assert.throws(
        () =>
          run(changed.program, JSON.parse(JSON.stringify(states[1])), {
            reply: "released",
          }),
        /mismatch/,
      );
    }
    results.push({ name: c.name, trace, outcome: r.outcome, freshProcesses: pids.length });
    console.log("PASS", c.name);
  }
  assert.throws(
    () =>
      build(
        'function* workflow(ctx) { "use workflow"; try { return "body"; } finally { return "bad"; } }',
      ),
    (e) => e.code === "workflow_cleanup_return",
  );
  assert.throws(
    () =>
      build(
        'function* workflow(ctx) { "use workflow"; try { return "body"; } catch (e) { return e; } }',
      ),
    /Only try\/finally/,
  );
  fs.writeFileSync(
    dir + "results.json",
    JSON.stringify(
      {
        cases: results,
        returnFromFinally: "rejected",
        catch: "not supported",
        semantics:
          "Finally finishes before cancellation propagates; errors from cleanup replace pending outcomes. Cancellation cannot resume ordinary caller code.",
        limitations: [
          "Experimental JS Scheme-subset VM, not Hoot/Wasm",
          "Sequential nested scopes; no spawn integration",
          "Scope-owned ensure and lexical finally supported",
          "Trusted snapshots only; no journal crash-window recovery",
          "Throw values and host errors are portable data; no Error object serialization",
          "Conservative executable identity checks only; no migrations",
        ],
      },
      null,
      2,
    ) + "\n",
  );
}
