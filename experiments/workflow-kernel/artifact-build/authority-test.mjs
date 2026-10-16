import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildBundle } from "./build.mjs";
import { loadBundle } from "./load.mjs";
import { createCompiledPullTool } from "./pull-adapter.mjs";
import { createCompiledProgramDriver } from "./program-driver.mjs";
import {
    createAuthorityScenarioDriver,
    driveTestProgramTree,
} from "../../../packages/journal-authority/dist/testing.js";
import { createCapabilityKeyring } from "../../../packages/journal-authority/dist/index.js";
import { ProgramDriverRegistryContext } from "../../../packages/durable-execution/dist/index.js";
const { run } = createRequire(new URL("../../../package.json", import.meta.url))("effection");
const source = fs.readFileSync(
    new URL("../tool-contracts/iteration-scope.ts", import.meta.url),
    "utf8",
);
const bundle = buildBundle(source),
    tool = createCompiledPullTool(bundle),
    { schemas } = loadBundle(bundle);
let checks = 0;
const check = (fn) => {
    fn();
    checks++;
};
for (const mode of ["complete", "complete-uncached", "cancel-acquire", "cancel-cleanup"]) {
    await run(function* () {
        const cache = new Map(),
            observations = [];
        const options = {
            journalId: "compiled-proof-" + mode,
            journalIncarnation: "1",
            schemaRegistry: schemas,
            keyring: createCapabilityKeyring("proof", [
                { keyId: "key", secret: "compiled-spike-secret-longer-than-32-bytes" },
            ]),
        };
        let authority = yield* createAuthorityScenarioDriver(options);
        const attach = {
            sessionId: "session-" + mode,
            taskId: "turn-0/root",
            program: {
                id: tool.manifest.programId,
                version: tool.manifest.version,
                digest: tool.manifest.digest,
            },
            input: { count: 2 },
            route: { driverKind: "compiled-spike" },
            executionEpoch: 1,
        };
        yield* authority.openTask({
            ...attach,
            turnId: "turn-0",
            manifest: tool.manifest,
            attachmentId: "unattached",
            audience: "fixture",
        });
        let holds = 0,
            cancelled = false;
        const seen = [];
        for (let i = 0; i < 10; i++) {
            // Replace both host/driver and authority shell between activations.
            const driver = createCompiledProgramDriver(bundle, {
                cache: mode === "complete-uncached" ? new Map() : cache,
                observe: (event) => observations.push(event),
            });
            const result = yield* ProgramDriverRegistryContext.with(
                new Map([["compiled-spike", driver]]),
                function* () {
                    return yield* driveTestProgramTree(authority, { attach });
                },
            );
            if (result.state !== "parked") {
                check(() =>
                    assert.deepEqual(
                        result,
                        mode.startsWith("complete")
                            ? { state: "completed", value: 0 }
                            : { state: "cancelled" },
                    ),
                );
                break;
            }
            const journal = authority.readJournal(attach.sessionId);
            const pending = journal.find(
                (r) => r.payload.type === "PullRequested" && r.payload.pullId === result.pullId,
            ).payload;
            seen.push(pending.descriptor.key);
            if (
                !cancelled &&
                ((mode === "cancel-acquire" && pending.descriptor.key === "acquire") ||
                    (mode === "cancel-cleanup" && pending.descriptor.key === "release"))
            ) {
                yield* authority.requestCancellation(
                    attach.sessionId,
                    attach.taskId,
                    "test cancel",
                    "cancel-1",
                );
                cancelled = true;
            } else {
                const reply =
                    pending.descriptor.key === "acquire"
                        ? { action: "accept", content: { id: "hold-" + ++holds } }
                        : { action: "accept", content: "released" };
                const capability = authority.resolutionCapability(
                    attach.sessionId,
                    attach.taskId,
                    result.pullId,
                );
                const resolution = yield* authority.resolve({
                    capability,
                    audience: "user:" + pending.descriptor.key,
                    outcome: { status: "ok", value: reply },
                });
                check(() =>
                    assert.notEqual(resolution.status, "rejected", JSON.stringify(resolution)),
                );
            }
            authority = yield* createAuthorityScenarioDriver({
                ...options,
                snapshot: authority.exportSnapshot(),
            });
            if (i === 9) throw Error("Did not settle");
        }
        check(() => assert.ok(observations.some((x) => x.type === "activation-discarded")));
        if (mode.startsWith("complete")) {
            check(() => assert.deepEqual(seen, ["acquire", "release", "acquire", "release"]));
            if (mode === "complete")
                check(() => assert.ok(observations.some((x) => x.type === "checkpoint-restored")));
        }
        if (mode === "cancel-acquire") check(() => assert.deepEqual(seen, ["acquire"]));
        if (mode === "cancel-cleanup")
            check(() => assert.deepEqual(seen, ["acquire", "release", "release"]));
        console.log("PASS real authority", mode, JSON.stringify(seen));
    });
}
console.log("PASS", checks, "authority integration checks");
