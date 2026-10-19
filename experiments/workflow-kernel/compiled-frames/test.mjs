import fs from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { compileWorkflow, inspect, compatibility } from "./compiler.mjs";
import { start, run } from "../continuation-compiler/engine.mjs";
const dir = fileURLToPath(new URL(".", import.meta.url));
if (process.argv[2] === "step") {
    const artifact = JSON.parse(fs.readFileSync(dir + "artifact.json")),
        state = JSON.parse(fs.readFileSync(dir + "checkpoint.json"));
    const result = run(
        artifact.program,
        state,
        process.argv[3] === undefined ? {} : { reply: JSON.parse(process.argv[3]) },
    );
    fs.writeFileSync(dir + "checkpoint.json", JSON.stringify(state));
    console.log(
        JSON.stringify({
            effect: result.effect,
            done: result.done,
            inspection: inspect(artifact, state),
            pid: process.pid,
        }),
    );
} else {
    const source = fs.readFileSync(dir + "workflow.ts", "utf8"),
        artifact = compileWorkflow(source);
    fs.writeFileSync(dir + "artifact.json", JSON.stringify(artifact, null, 2));
    fs.writeFileSync(dir + "workflow.scm", artifact.scheme);
    fs.writeFileSync(dir + "checkpoint.json", JSON.stringify(start(artifact.program)));
    const native = vm.runInNewContext(source + "\nworkflow")({
        elicit: function* (question) {
            return yield ["elicit", question];
        },
    });
    const reports = [];
    for (const reply of [undefined, "Paris", "12A", true]) {
        const baseline = native.next(reply);
        const child = spawnSync(
            process.execPath,
            [
                fileURLToPath(import.meta.url),
                "step",

                ...(reply === undefined ? [] : [JSON.stringify(reply)]),
            ],
            { encoding: "utf8" },
        );
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout);
        assert.deepEqual(result.effect ?? result.done, JSON.parse(JSON.stringify(baseline.value)));
        if (!baseline.done) {
            fs.copyFileSync(dir + "checkpoint.json", dir + `checkpoint-${reports.length}.json`);
        }
        reports.push(result);
    }
    assert.deepEqual(
        reports[0].inspection.frames.map((f) => f.function),
        ["workflow", "choose"],
    );
    assert.deepEqual(
        reports[1].inspection.frames.map((f) => f.function),
        ["workflow", "plan", "choose"],
    );
    assert.equal(reports[1].inspection.frames[1].locals.destination, "Paris");
    assert.equal(reports[2].inspection.frames.at(-1).locals.seat, "12A");
    assert.equal(reports[2].inspection.site, "plan/confirmed");
    assert.equal(new Set(reports.map((r) => r.pid)).size, 4);
    const formatting = compileWorkflow("// New comment\n\n" + source),
        changed = compileWorkflow(source.replace("Confirm booking", "Confirm itinerary"));
    assert.equal(compatibility(artifact, formatting).compatible, true);
    assert.equal(compatibility(artifact, changed).compatible, false);
    // Resume the SAME saved state under formatting-only output, reject changed code.
    const paused = start(artifact.program);
    run(artifact.program, paused);
    assert.deepEqual(
        run(formatting.program, JSON.parse(JSON.stringify(paused)), { reply: "Paris" }).effect,
        ["elicit", "Pick a seat"],
    );
    assert.throws(
        () => run(changed.program, JSON.parse(JSON.stringify(paused)), { reply: "Paris" }),
        /mismatch/,
    );
    assert.throws(
        () => compileWorkflow(source.replace("function* choose", "async function* choose")),
        /Expected/,
    );
    assert.throws(
        () => compileWorkflow(source.replace("yield* ctx.elicit(question)", "yield question")),
        /Unsupported/,
    );
    const report = {
        steps: reports,
        compatibility: {
            formatting: compatibility(artifact, formatting),
            changedEffect: compatibility(artifact, changed),
        },
        limitations: [
            "Restricted straight-line frontend, separate from the Guile loop frontend",
            "Experimental JavaScript Scheme-subset VM, not Hoot or Wasm",
            "Trusted checkpoint input; no storage/journal integration",
            "No cancellation unwinding or schema compatibility proof",
            "Compatibility is exact executable identity only; no migration attempted",
        ],
    };
    fs.writeFileSync(dir + "results.json", JSON.stringify(report, null, 2) + "\n");
    console.log(
        "PASS: nested frames, locals, four fresh processes, native trace parity, formatting resume, changed-code rejection",
    );
}
