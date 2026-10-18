import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { compile, start, run } from "./engine.mjs";
if (process.argv[2] === "step") {
    const p = JSON.parse(fs.readFileSync("program.json")),
        state = JSON.parse(fs.readFileSync("checkpoint.json"));
    const r = run(
        p,
        state,
        process.argv[3] === undefined ? {} : { reply: JSON.parse(process.argv[3]) },
    );
    fs.writeFileSync("checkpoint.json", JSON.stringify(state));
    console.log(
        JSON.stringify({
            effect: r.effect,
            done: r.done,
            pid: process.pid,
            bytes: fs.statSync("checkpoint.json").size,
            maxFrames: state.maxFrames,
        }),
    );
} else {
    const p = compile(fs.readFileSync("workflow.scm", "utf8"));
    fs.writeFileSync("program.json", JSON.stringify(p));
    fs.writeFileSync("checkpoint.json", JSON.stringify(start(p)));
    const results = [];
    for (const [reply, expected] of [
        [undefined, "prefix"],
        [null, [0, 10]],
        [1, [1, 12]],
        [2, [2, 16]],
        [3, [3, 22]],
        [4, 26],
    ]) {
        const c = spawnSync(
            process.execPath,
            [
                new URL(import.meta.url).pathname,
                "step",

                ...(reply === undefined ? [] : [JSON.stringify(reply)]),
            ],
            { encoding: "utf8" },
        );
        assert.equal(c.status, 0, c.stderr);
        const r = JSON.parse(c.stdout);
        assert.deepEqual(r.effect ?? r.done, expected);
        results.push(r);
    }
    const tail = compile("(define (count n) (if (= n 0) 0 (count (- n 1)))) (count 10000)"),
        ts = start(tail);
    assert.equal(run(tail, ts, { fuel: 200000 }).done, 0);
    assert.equal(ts.maxFrames, 1);
    const cl = compile(
        '(let ((prefix "Hello, ")) (let ((greet (lambda (name) (string-append prefix name)))) (greet (yield "name"))))',
    );
    let cs = start(cl);
    assert.equal(run(cl, cs).effect, "name");
    cs = JSON.parse(JSON.stringify(cs));
    assert.equal(run(cl, cs, { reply: "Ryan" }).done, "Hello, Ryan");
    assert.throws(() => run(cl, start(p)), /mismatch/);
    assert.throws(() => compile("(set! x 1)"), /Unsupported/);
    const inf = compile("(define (loop) (loop)) (loop)");
    assert.throws(() => run(inf, start(inf), { fuel: 100 }), /budget/);
    const report = {
        freshProcessSteps: results,
        tailCalls: 10000,
        tailCallMaxFrames: ts.maxFrames,
        closureRestore: "passed",
        mismatchRejected: true,
        unsupportedFormRejected: true,
        fuelExhaustion: "passed",
        limitations: [
            "Experimental subset, no macros or arbitrary call/cc",
            "JavaScript host prototype, not Wasm",
            "Trusted checkpoints only",
            "No static typing",
            "Heap garbage collection not yet implemented",
        ],
    };
    fs.writeFileSync("results.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
}
