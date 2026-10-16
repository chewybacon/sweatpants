import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { verifyProgramIdentityProvenance } from "../../../packages/durable-execution/dist/index.js";
import { buildBundle } from "./build.mjs";
import { createCompiledPullTool, createPullMachine } from "./pull-adapter.mjs";
import { compileToolDefinition } from "../tool-contracts/compiler.mjs";
import { copy } from "../compiled-finally/journal.mjs";
const { run } = createRequire(new URL("../../../package.json", import.meta.url))("effection");
const source = fs.readFileSync(
    new URL("../tool-contracts/iteration-scope.ts", import.meta.url),
    "utf8",
);
const bundle = buildBundle(source),
    { tool } = compileToolDefinition(source);
let checks = 0;
const check = (fn) => {
    fn();
    checks++;
};
async function execute(program, mode) {
    const trace = [];
    let holds = 0;
    try {
        const value = await run(() =>
            program(
                { count: 3 },
                {
                    pull: function* (request) {
                        trace.push(request);
                        if (mode === "release-error" && request.key === "release")
                            throw "Release failed";
                        if (mode === "declined") return { action: "decline" };
                        return request.key === "acquire"
                            ? { action: "accept", content: { id: "hold-" + ++holds } }
                            : { action: "accept", content: "released" };
                    },
                },
            ),
        );
        return { trace, outcome: { kind: "returned", value } };
    } catch (value) {
        return { trace, outcome: { kind: "thrown", value } };
    }
}
const compiledTool = createCompiledPullTool(bundle),
    program = compiledTool.program;
check(() => verifyProgramIdentityProvenance(compiledTool, { releaseStrict: true }));
check(() =>
    assert.equal(
        compiledTool.identityArtifact.input.implementationArtifactDigest,
        bundle.artifact.id,
    ),
);
for (const mode of ["normal", "release-error", "declined"]) {
    const expected = await execute(tool.program, mode),
        actual = await execute(program, mode);
    check(() => assert.deepEqual(actual, expected));
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pull-proof-"));
try {
    const bundlePath = path.join(dir, "bundle.json");
    fs.writeFileSync(bundlePath, JSON.stringify(bundle));
    const input = { count: 3 };
    const pids = new Set();
    function fresh(snapshot, reply) {
        const child = spawnSync(
            process.execPath,
            [
                "--import",
                new URL("./no-compiler.mjs", import.meta.url).pathname,
                new URL("./pull-worker.mjs", import.meta.url).pathname,
            ],
            {
                input: JSON.stringify({ bundlePath, input, snapshot, reply }),
                encoding: "utf8",
                timeout: 20000,
            },
        );
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout);
        assert.ok(!pids.has(result.pid));
        pids.add(result.pid);
        return result;
    }
    let next = fresh(),
        holds = 0;
    const trace = [];
    while (next.frontier.type === "pull") {
        const { descriptor } = next.frontier;
        trace.push(descriptor);
        // Park/drop/reload must neither advance nor trigger registered cleanup.
        const restored = fresh(next.snapshot);
        check(() => assert.deepEqual(restored.frontier, next.frontier));
        check(() => assert.deepEqual(restored.snapshot, next.snapshot));
        const reply =
            descriptor.key === "acquire"
                ? { action: "accept", content: { id: "hold-" + ++holds } }
                : { action: "accept", content: "released" };
        next = fresh(next.snapshot, reply);
    }
    const native = await execute(tool.program, "normal");
    check(() => assert.deepEqual(trace, native.trace));
    check(() => assert.deepEqual(next.frontier.outcome, native.outcome));
    const bad = copy(next.snapshot);
    bad.state.status = "waiting";
    check(() => assert.throws(() => createPullMachine(bundle, input, bad), /identity/));
    check(() =>
        assert.throws(() => createPullMachine(bundle, { count: 4 }, next.snapshot), /identity/),
    );
    check(() => assert.throws(() => createPullMachine(bundle, { count: -1 }), /validation/));
    const pending = createPullMachine(bundle, input),
        before = pending.capture();
    check(() =>
        assert.throws(
            () => pending.resume({ action: "accept", content: "bad hold" }),
            /validation/,
        ),
    );
    check(() => assert.deepEqual(pending.capture(), before));
    console.log(
        "PASS",
        checks,
        "pull adapter checks;",
        pids.size,
        "compiler-free processes; native SDK descriptors match",
    );
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
