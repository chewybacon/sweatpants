import fs from "node:fs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create, recover, appendCommand, repair, copy, hash } from "./journal.mjs";
import { artifact } from "./artifact.mjs";
import { textV1, textV2, choice, ack, createDurableSchemaRegistry } from "./schemas.mjs";
const dir = fileURLToPath(new URL(".", import.meta.url));
if (process.argv[2] === "repair") {
    const { a, record } = JSON.parse(fs.readFileSync(0, "utf8"));
    console.log(JSON.stringify(repair(record, { [a.id]: a })));
} else {
    let checks = 0;
    const source =
        'function* workflow(ctx) { "use workflow"; try { const answer = yield* ctx.elicit("choose"); return answer; } finally { yield* ctx.elicit("release"); } }';
    const initial = artifact(source);
    const contracts = Object.fromEntries(
        Object.keys(initial.contracts).map((site) => [
            site,
            {
                reply: site.endsWith("/answer") ? choice.descriptor.digest : ack.descriptor.digest,
                error: textV1.descriptor.digest,
            },
        ]),
    );
    const a = artifact(source, contracts),
        registry = { [a.id]: a };
    let record = create(a, "typed");
    const append = (r, input, id = "reply") =>
        appendCommand(r, registry, {
            id,
            requestId: recover(r, registry).pending.id,
            input,
            revision: r.events.length,
        });
    function fresh(a, record) {
        const p = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "repair"], {
            input: JSON.stringify({ a, record }),
            encoding: "utf8",
            timeout: 10000,
        });
        assert.equal(p.status, 0, p.stderr);
        return JSON.parse(p.stdout);
    }
    const unchanged = JSON.stringify(record);
    for (const invalid of [
        null,
        "window",
        {},
        { seat: "middle", count: 1 },
        { seat: "window", count: 0 },
        { seat: "aisle", count: 1.5 },
        { seat: "window", count: 2, extra: true },
    ]) {
        assert.throws(() => append(record, { reply: invalid }), /reply schema validation failed/);
        assert.equal(JSON.stringify(record), unchanged);
        checks++;
    }
    assert.throws(
        () => append(record, { error: { message: "bad" } }),
        /error schema validation failed/,
    );
    checks++;
    const accepted = append(record, { reply: { seat: "window", count: 2 } });
    record = fresh(a, accepted);
    assert.equal(recover(record, registry).pending.request[1], "release");
    assert.throws(
        () => append(record, { reply: "done" }, "release"),
        /reply schema validation failed/,
    );
    checks++;
    const oldCheckpoint = copy(accepted);
    delete oldCheckpoint.checkpoint;
    assert.deepEqual(fresh(a, oldCheckpoint), record);
    checks++;
    record = fresh(a, append(record, { reply: null }, "release"));
    assert.deepEqual(recover(record, registry).state.outcome, {
        kind: "returned",
        value: { seat: "window", count: 2 },
    });
    checks++;
    // Re-hash an invalid command to demonstrate semantic replay validation beyond checksums.
    const invalidJournal = copy(accepted);
    invalidJournal.events.at(-1).input.reply = { seat: "middle", count: 2 };
    const { hash: ignored, ...body } = invalidJournal.events.at(-1);
    invalidJournal.events.at(-1).hash = hash(body);
    assert.throws(() => repair(invalidJournal, registry), /reply schema validation failed/);
    checks++;
    assert.throws(() => artifact(source, {}), /coverage/);
    checks++;
    const simple =
        'function* workflow(ctx) { "use workflow"; const answer = yield* ctx.elicit("answer"); return answer; }';
    const old = artifact(simple),
        site = Object.keys(old.contracts)[0];
    const next = artifact(simple, {
        [site]: { reply: textV2.descriptor.digest, error: textV1.descriptor.digest },
    });
    assert.equal(old.compiled.program.id, next.compiled.program.id);
    assert.notEqual(old.id, next.id);
    checks++;
    const both = { [old.id]: old, [next.id]: next },
        oldRecord = create(old, "old");
    const oldAccepted = appendCommand(oldRecord, both, {
        id: "old-reply",
        requestId: recover(oldRecord, both).pending.id,
        input: { reply: "legacy answer" },
        revision: oldRecord.events.length,
    });
    assert.equal(recover(fresh(old, oldAccepted), both).state.outcome.value, "legacy answer");
    checks++;
    const newRecord = create(next, "new");
    assert.throws(
        () =>
            appendCommand(newRecord, both, {
                id: "new-reply",
                requestId: recover(newRecord, both).pending.id,
                input: { reply: "legacy answer" },
                revision: newRecord.events.length,
            }),
        /reply schema validation failed/,
    );
    checks++;
    assert.throws(
        () => recover(oldRecord, both, createDurableSchemaRegistry([textV2])),
        /Missing pinned schema validator/,
    );
    checks++;
    assert.throws(
        () => create(old, "missing", createDurableSchemaRegistry([textV2])),
        /Missing pinned schema validator/,
    );
    checks++;
    const wrongCheckpoint = copy(oldRecord);
    wrongCheckpoint.checkpoint.pending.contract.reply = textV2.descriptor.digest;
    const { checksum: oldChecksum, ...cp } = wrongCheckpoint.checkpoint;
    wrongCheckpoint.checkpoint.checksum = hash(cp);
    assert.throws(() => recover(wrongCheckpoint, both), /Checkpoint effect contract mismatch/);
    checks++;
    assert.throws(() => recover(oldRecord, { [next.id]: next }), /Missing pinned artifact/);
    checks++;
    fs.writeFileSync(
        dir + "schema-results.json",
        JSON.stringify(
            {
                checks,
                validation:
                    "Workspace built foundation portable descriptors + journal-authority Standard Schema registry; Zod validators",
                outcome: recover(record, registry).state.outcome,
                versioning: {
                    sameExecutable: old.compiled.program.id === next.compiled.program.id,
                    differentArtifact: old.id !== next.id,
                    oldContractRetained: true,
                },
                limitations: [
                    "Contracts supplied explicitly in the spike; not inferred from SDK tool definitions",
                    "No static TS type checking",
                    "Validator implementations must remain deployed under their pinned schema digests",
                    "Non-transforming validators only; normalization rejected",
                    "Existing JSON journal harness, not production storage integration",
                ],
            },
            null,
            2,
        ) + "\n",
    );
    console.log("PASS", checks, "schema checks");
}
