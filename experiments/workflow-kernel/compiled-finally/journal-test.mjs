import fs from "node:fs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create, recover, appendCommand, repair, copy } from "./journal.mjs";
import { artifact } from "./artifact.mjs";
const dir = fileURLToPath(new URL(".", import.meta.url));
if (process.argv[2] === "repair") {
    const { record, a } = JSON.parse(fs.readFileSync(0, "utf8"));
    console.log(JSON.stringify({ record: repair(record, { [a.id]: a }), pid: process.pid }));
} else {
    const a = artifact(fs.readFileSync(dir + "scopes.ts", "utf8")),
        registry = { [a.id]: a };
    let restarts = 0;
    const pids = new Set();
    function fresh(record) {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "repair"], {
            input: JSON.stringify({ record, a }),
            encoding: "utf8",
            timeout: 10000,
        });
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout);
        pids.add(result.pid);
        restarts++;
        return result.record;
    }
    const results = [];
    for (const scenario of [
        { name: "normal" },
        { name: "cancel body", cancelAt: "body" },
        { name: "cancel during cleanup", cancelAt: "deep cleanup" },
        { name: "cleanup error", errorAt: "deep cleanup" },
    ]) {
        let record = create(a, scenario.name),
            initial = copy(record.checkpoint),
            cancelled = false,
            commands = 0;
        const trace = [],
            seenRequests = new Set();
        for (let i = 0; i < 25; i++) {
            const ctx = recover(record, registry);
            if (ctx.state.status === "done") break;
            const label = ctx.pending.request[1];
            const cancel = label === scenario.cancelAt && !cancelled;
            if (!seenRequests.has(ctx.pending.id)) {
                trace.push(label);
                seenRequests.add(ctx.pending.id);
            }
            if (cancel) cancelled = true;
            const input = cancel
                ? { cancel: true }
                : label === scenario.errorAt
                  ? { error: "failure" }
                  : { reply: label === "body" ? "answer" : "released" };
            const command = {
                id: `command-${commands++}`,
                requestId: ctx.pending.id,
                input,
                revision: record.events.length,
            };
            const previousCheckpoint = copy(record.checkpoint);
            const appended = appendCommand(record, registry, command);
            // Stop after recording the accepted input, before publishing the next effect/checkpoint.
            const canonical = fresh(appended);
            if (
                cancel &&
                (ctx.state.scopes.some((s) => s.phase === "cleanup") ||
                    ctx.state.frames.some((f) => f.handlers.some((h) => h.phase === "cleanup")))
            ) {
                assert.equal(
                    recover(canonical, registry).pending.id,
                    ctx.pending.id,
                    "Shielded cancellation must preserve the pending effect identity",
                );
                assert.equal(
                    canonical.events.length,
                    appended.events.length,
                    "Shielded cancellation must not publish a duplicate effect",
                );
            }
            // No checkpoint: derive all state from the journal without executing host effects.
            const fromBeginning = copy(appended);
            delete fromBeginning.checkpoint;
            assert.deepEqual(fresh(fromBeginning), canonical);
            // Old initial checkpoint, with multiple recorded replies to replay.
            const fromOld = copy(appended);
            fromOld.checkpoint = initial;
            assert.deepEqual(fresh(fromOld), canonical);
            // Stop after publishing the next request, before persisting its checkpoint.
            const afterPublish = copy(canonical);
            afterPublish.checkpoint = previousCheckpoint;
            assert.deepEqual(fresh(afterPublish), canonical);
            assert.deepEqual(
                appendCommand(canonical, registry, command),
                canonical,
                "Exact duplicate is idempotent",
            );
            assert.throws(
                () =>
                    appendCommand(canonical, registry, {
                        ...command,
                        input: { reply: "conflict" },
                    }),
                /Conflicting duplicate/,
            );
            assert.throws(
                () => appendCommand(canonical, registry, { ...command, id: "new", revision: -1 }),
                /Revision conflict/,
            );
            if (recover(canonical, registry).pending?.id !== command.requestId)
                assert.throws(
                    () =>
                        appendCommand(canonical, registry, {
                            ...command,
                            id: "stale",
                            revision: canonical.events.length,
                        }),
                    /Stale effect/,
                );
            record = canonical;
        }
        const completed = recover(record, registry);
        assert.equal(completed.state.status, "done");
        assert.equal(completed.state.scopes.length, 0);
        assert.equal(record.events.filter((e) => e.kind === "done").length, 1);
        if (scenario.cancelAt) {
            assert.equal(completed.state.outcome.kind, "cancelled");
            assert.ok(!trace.includes("after inner scope"));
        }
        if (scenario.errorAt)
            assert.deepEqual(completed.state.outcome, { kind: "thrown", value: "failure" });
        if (scenario.name === "normal") {
            assert.deepEqual(completed.state.outcome, { kind: "returned", value: "answer" });
            fs.writeFileSync(dir + "journal-record.json", JSON.stringify(record, null, 2));
            const bad = copy(record);
            bad.events[0].request = ["elicit", "tampered"];
            assert.throws(() => recover(bad, registry), /Journal integrity/);
            const corrupt = copy(record);
            corrupt.checkpoint.state.status = "waiting";
            assert.throws(() => recover(corrupt, registry), /Checkpoint integrity/);
            const wrong = copy(a);
            wrong.engine = "different";
            assert.throws(() => recover(record, { [a.id]: wrong }), /Artifact integrity/);
        }
        results.push({
            ...scenario,
            commands,
            events: record.events.length,
            trace,
            outcome: completed.state.outcome,
        });
        console.log("PASS", scenario.name);
    }
    assert.equal(pids.size, restarts);
    fs.writeFileSync(
        dir + "journal-results.json",
        JSON.stringify(
            {
                cases: results,
                freshProcessRestarts: restarts,
                checks: [
                    "accepted input persisted before execution",
                    "request published before checkpoint",
                    "old checkpoint replay",
                    "checkpoint-free replay",
                    "duplicate commands",
                    "stale replies",
                    "revision conflict",
                    "journal/checkpoint/artifact integrity",
                ],
                limitations: [
                    "File/JSON harness, not a production storage adapter",
                    "No concurrent writer transaction tests",
                    "No external side effects are executed; responses are scripted",
                    "Pinned schema validators; no inference from SDK tool definitions",
                    "Recovery pins exact artifact and evaluator; no migration",
                ],
            },
            null,
            2,
        ) + "\n",
    );
    console.log("PASS", restarts, "fresh-process recovery windows");
}
