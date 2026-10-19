import fs from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileWorkflow } from "../compiled-frames/compiler.mjs";
import { compile, start, run } from "./engine.mjs";
const dir = fileURLToPath(new URL(".", import.meta.url));
if (process.argv[2] === "step") {
    const { artifact, state, options } = JSON.parse(fs.readFileSync(0, "utf8"));
    console.log(JSON.stringify({ ...run(artifact.program, state, options), pid: process.pid }));
} else {
    const {
        run: effRun,
        ensure,
        action,
    } = createRequire(import.meta.url)(
        "../../../node_modules/.pnpm/effection@4.2.0/node_modules/effection/script/mod.js",
    );
    const base = fs.readFileSync(dir + "mixed.ts", "utf8");
    const cases = [
        { name: "normal" },
        { name: "body error", errorAt: "body" },
        { name: "lexical cleanup error", errorAt: "child finally" },
        { name: "ensure error with finally", errorAt: "child ensure" },
        { name: "cancel body", cancelAt: "body" },
        { name: "cancel lexical cleanup", cancelAt: "child finally" },
        { name: "cancel scope cleanup", cancelAt: "child ensure" },
        { name: "cancel finally inside ensure", cancelAt: "ensure finally" },
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
        const workflow = vm.runInNewContext(
            source.replace("import { ensure } from 'effection';", "") + "\nworkflow",
            { ensure },
        );
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
        const artifact = compileWorkflow(base, {
            compileScheme: compile,
            allowFinally: true,
            allowEnsure: true,
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
                    r.state.scopePhase === "cleanup" ||
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
                if (label === "child ensure" && c.name === "normal") {
                    fs.writeFileSync(
                        dir + "mixed-checkpoint.json",
                        JSON.stringify(r.state, null, 2),
                    );
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
            const expected = await native(base, c.errorAt);
            assert.deepEqual(trace, expected.trace, c.name);
            assert.deepEqual(r.outcome, expected.outcome, c.name);
        } else {
            assert.deepEqual(r.outcome, { kind: "cancelled" });
            if (c.cancelAt === "body" || c.cancelAt === "child finally") {
                assert.ok(!trace.includes("parent continued"));
            }
            assert.deepEqual(trace.slice(-4), [
                "registered in finally",
                "child ensure",
                "ensure finally",
                "outer ensure",
            ]);
        }
        results.push({ ...c, trace, outcome: r.outcome, freshProcesses: pids.length });
        console.log("PASS", c.name);
    }
    fs.writeFileSync(
        dir + "mixed-results.json",
        JSON.stringify(
            {
                cases: results,
                reference:
                    "Native Effection 4.2.0 for normal/error paths. Cancellation asserts explicit unwind semantics rather than matching known native finally bugs.",
                limitations: [
                    "Nested sequential scopes supported; no spawn yet",
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
