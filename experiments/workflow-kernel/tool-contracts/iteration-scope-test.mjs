import fs from "node:fs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { compileToolDefinition } from "./compiler.mjs";
import { create, recover, appendCommand, repair, copy } from "../compiled-finally/journal.mjs";
import { inspect } from "../compiled-frames/compiler.mjs";
const source = fs.readFileSync(new URL("./iteration-scope.ts", import.meta.url), "utf8");
const { artifact: a, schemas, tool } = compileToolDefinition(source),
    registry = { [a.id]: a };
const fresh = (record) => {
    const child = spawnSync(
        process.execPath,
        [new URL("./test.mjs", import.meta.url).pathname, "resume"],
        { input: JSON.stringify({ source, record }), encoding: "utf8", timeout: 20000 },
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
};
const results = [];
let checks = 0;
for (const mode of ["normal", "cancel-cleanup", "cleanup-error", "cancel-acquire"]) {
    let record = create(a, mode, schemas, { count: 3 }),
        acquired = 0;
    const trace = [];
    while (recover(record, registry, schemas).pending) {
        let ctx = recover(record, registry, schemas);
        const request = ctx.pending.request;
        trace.push([request[1], request[2].message]);
        assert.equal(ctx.state.scopes.length, 2);
        checks++;
        if (request[1] === "release") {
            assert.equal(ctx.state.scopes[1].phase, "cleanup");
            assert.equal(ctx.state.scopes[0].phase, "body");
            assert.equal(ctx.state.scopes[1].parent, ctx.state.scopes[0].id);
            assert.equal(ctx.state.scopes[1].outcome.value, `hold-${acquired}`);
            checks++;
            if (mode === "cancel-cleanup") {
                const pendingId = ctx.pending.id;
                record = appendCommand(
                    record,
                    registry,
                    {
                        id: "cancel",
                        requestId: pendingId,
                        input: { cancel: true },
                        revision: record.events.length,
                    },
                    schemas,
                );
                record = fresh(record);
                ctx = recover(record, registry, schemas);
                assert.equal(ctx.pending.id, pendingId);
                assert.equal(ctx.state.cancellationRequested, true);
                assert.deepEqual(ctx.pending.request, request);
                const duplicate = appendCommand(
                    record,
                    registry,
                    {
                        id: "cancel",
                        requestId: pendingId,
                        input: { cancel: true },
                        revision: record.events.length,
                    },
                    schemas,
                );
                assert.deepEqual(duplicate, record);
                checks++;
                fs.writeFileSync(
                    new URL("./iteration-cleanup-checkpoint.json", import.meta.url),
                    JSON.stringify(
                        { record, inspection: inspect(a.compiled, ctx.state) },
                        null,
                        2,
                    ) + "\n",
                );
            }
        }
        let input =
            request[1] === "acquire"
                ? { reply: { action: "accept", content: { id: `hold-${++acquired}` } } }
                : { reply: { action: "accept", content: "released" } };
        if (mode === "cleanup-error" && request[1] === "release")
            input = { error: "release failed" };
        if (mode === "cancel-acquire") input = { cancel: true };
        const accepted = appendCommand(
            record,
            registry,
            {
                id: `step-${record.events.length}`,
                requestId: ctx.pending.id,
                input,
                revision: record.events.length,
            },
            schemas,
        );
        const replay = copy(accepted);
        delete replay.checkpoint;
        record = fresh(accepted);
        assert.deepEqual(record, repair(replay, registry, schemas));
        checks++;
    }
    const outcome = record.events.at(-1).outcome;
    if (mode === "normal") {
        assert.deepEqual(trace, [
            ["acquire", "Reserve a hold"],
            ["release", "hold-1"],
            ["acquire", "Reserve a hold"],
            ["release", "hold-2"],
            ["acquire", "Reserve a hold"],
            ["release", "hold-3"],
        ]);
        assert.deepEqual(outcome, { kind: "returned", value: 0 });
    } else if (mode === "cleanup-error") {
        assert.deepEqual(outcome, { kind: "thrown", value: "release failed" });
        assert.equal(trace.length, 2);
    } else {
        assert.deepEqual(outcome, { kind: "cancelled" });
        assert.equal(trace.length, mode === "cancel-cleanup" ? 2 : 1);
    }
    assert.deepEqual(repair(record, registry, schemas), record);
    checks++;
    results.push({ mode, trace, outcome });
}
// Native Effection owns cleanup ordering; compare success and cleanup error.
const { run } = createRequire(new URL("../../../package.json", import.meta.url))("effection");
for (const mode of ["normal", "cleanup-error"]) {
    const trace = [];
    let acquired = 0,
        outcome;
    try {
        const value = await run(() =>
            tool.program(
                { count: 3 },
                {
                    pull: function* (request) {
                        trace.push([request.key, request.message]);
                        if (mode === "cleanup-error" && request.key === "release")
                            throw "release failed";
                        return request.key === "acquire"
                            ? { action: "accept", content: { id: `hold-${++acquired}` } }
                            : { action: "accept", content: "released" };
                    },
                },
            ),
        );
        outcome = { kind: "returned", value };
    } catch (value) {
        outcome = { kind: "thrown", value };
    }
    assert.deepEqual(
        { mode, trace, outcome },
        results.find((r) => r.mode === mode),
    );
    checks++;
}
fs.writeFileSync(
    new URL("./iteration-scope-results.json", import.meta.url),
    JSON.stringify({ checks, results }, null, 2) + "\n",
);
console.log("PASS", checks, "iteration scope checks");
