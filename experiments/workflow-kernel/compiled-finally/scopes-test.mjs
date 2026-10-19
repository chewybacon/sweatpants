import fs from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileWorkflow, inspect } from "../compiled-frames/compiler.mjs";
import { compile, start, run } from "./engine.mjs";
const dir = fileURLToPath(new URL(".", import.meta.url));
if (process.argv[2] === "step") {
  const { artifact, state, options } = JSON.parse(fs.readFileSync(0, "utf8"));
  console.log(JSON.stringify({ ...run(artifact.program, state, options), pid: process.pid }));
} else {
  const {
    run: effRun,
    ensure,
    scoped,
    action,
  } = createRequire(import.meta.url)(
    "../../../node_modules/.pnpm/effection@4.2.0/node_modules/effection/script/mod.js",
  );
  const base = fs.readFileSync(dir + "scopes.ts", "utf8");
  const cases = [
    { name: "normal nested scope exit" },
    { name: "body error", errorAt: "body" },
    { name: "deep cleanup error", errorAt: "deep cleanup" },
    { name: "cancel body", cancelAt: "body" },
    { name: "cancel deep cleanup", cancelAt: "deep cleanup" },
    { name: "cancel inner cleanup", cancelAt: "inner cleanup" },
    { name: "cancel between scopes", cancelAt: "after deep scope" },
    { name: "aliased imports", aliases: true },
  ];
  function fresh(artifact, state, options = {}) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "step"], {
      input: JSON.stringify({ artifact, state, options }),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  }
  async function native(source, errorAt) {
    const trace = [];
    const ctx = {
      elicit: function* (label) {
        return yield* action((resolve, reject) => {
          trace.push(label);
          queueMicrotask(() =>
            label === errorAt
              ? reject("failure")
              : resolve(label === "body" ? "answer" : "released"),
          );
          return () => {};
        });
      },
    };
    const workflow = vm.runInNewContext(source.replace(/import[^;]+;/, "") + "\nworkflow", {
      ensure,
      scoped,
      onExit: ensure,
      inScope: scoped,
    });
    let outcome;
    try {
      outcome = { kind: "returned", value: await effRun(() => workflow(ctx)) };
    } catch (e) {
      outcome = { kind: "thrown", value: e };
    }
    return { trace, outcome };
  }
  const results = [];
  for (const c of cases) {
    const source = c.aliases
      ? base
          .replace("ensure, scoped", "ensure as onExit, scoped as inScope")
          .replaceAll("yield* ensure(", "yield* onExit(")
          .replaceAll("yield* scoped(", "yield* inScope(")
      : base;
    const artifact = compileWorkflow(source, {
      compileScheme: compile,
      allowFinally: true,
      allowEnsure: true,
      allowScopes: true,
    });
    let r = fresh(artifact, start(artifact.program)),
      cancelled = false;
    const trace = [],
      pids = [r.pid];
    for (let n = 0; n < 30 && r.state.status !== "done"; n++) {
      const label = r.effect[1];
      trace.push(label);
      if (label === c.cancelAt && !cancelled) {
        cancelled = true;
        const shielded =
          r.state.scopes.some((scope) => scope.phase === "cleanup") ||
          r.state.frames.some((f) => f.handlers.some((h) => h.phase === "cleanup"));
        r = fresh(artifact, r.state, { cancel: true });
        pids.push(r.pid);
        if (shielded) {
          assert.equal(r.waiting, true);
          const repeat = fresh(artifact, r.state, { cancel: true });
          assert.deepEqual(repeat.state, r.state);
          r = fresh(artifact, r.state, { reply: "released" });
          pids.push(r.pid);
        }
      } else {
        if (label === "deep cleanup" && c.name === "normal nested scope exit") {
          assert.equal(r.state.scopes.length, 3);
          const view = inspect(artifact, r.state);
          assert.equal(view.scopes[1].site, "workflow/result");
          assert.equal(view.scopes[2].source.operation, "scoped");
          fs.writeFileSync(dir + "scopes-inspection.json", JSON.stringify(view, null, 2));
          assert.deepEqual(
            r.state.scopes.map((s) => s.parent),
            [null, 0, 1],
          );
          assert.equal(r.state.scopes.at(-1).phase, "cleanup");
          assert.equal(r.state.scopes.at(-1).outcome.value, "answer");
          fs.writeFileSync(dir + "scopes-checkpoint.json", JSON.stringify(r.state, null, 2));
        }
        r = fresh(
          artifact,
          r.state,
          label === c.errorAt
            ? { error: "failure" }
            : { reply: label === "body" ? "answer" : "released" },
        );
        pids.push(r.pid);
      }
    }
    assert.equal(r.state.status, "done");
    assert.equal(new Set(pids).size, pids.length);
    if (!c.cancelAt) {
      const expected = await native(source, c.errorAt);
      assert.deepEqual(trace, expected.trace, c.name);
      assert.deepEqual(r.outcome, expected.outcome, c.name);
    } else {
      assert.deepEqual(r.outcome, { kind: "cancelled" });
      assert.ok(!trace.includes("after inner scope"));
      if (c.cancelAt !== "after deep scope" && c.cancelAt !== "inner cleanup") {
        assert.ok(!trace.includes("after deep scope"));
      }
      for (const label of [
        "helper cleanup",
        "deep cleanup",
        "deep finally",
        "inner cleanup",
        "outer cleanup",
      ]) {
        assert.equal(trace.filter((x) => x === label).length, 1, label);
      }
      assert.equal(trace.at(-1), "outer cleanup");
    }
    assert.equal(r.state.scopes.length, 0);
    results.push({ ...c, trace, outcome: r.outcome, freshProcesses: pids.length });
    console.log("PASS", c.name);
  }
  fs.writeFileSync(
    dir + "scopes-results.json",
    JSON.stringify(
      {
        cases: results,
        reference:
          "Native Effection 4.2.0 for normal/error paths. Cancellation asserts explicit unwind semantics rather than matching known native finally bugs.",
        limitations: [
          "Nested sequential scoped supported; no spawn/concurrent scopes",
          "Trusted JSON snapshots, no journal integration",
          "Experimental JS VM, not Hoot/Wasm",
          "Multiple cleanup-error aggregation not established",
        ],
      },
      null,
      2,
    ) + "\n",
  );
}
