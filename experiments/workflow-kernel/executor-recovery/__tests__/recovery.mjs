import assert from "node:assert/strict";
import { run, scoped } from "effection";
import { canonicalDigest } from "../../../../packages/foundation/dist/index.js";
import { manifest } from "../../hoot-composition/fixture-driver.mjs";
import { localHootTransport } from "../operative.mjs";
import {
    createExecutor,
    createWorkerTransport,
} from "../../../../packages/tool-runtime-local/src/styles/__tests__/fixtures/executor-transport.ts";

const attach = {
    sessionId: "executor-recovery",
    taskId: "root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: null,
    route: { driverKind: "hoot-composition" },
    executionEpoch: 1,
};
const seed = "trusted-fixture-seed";

// These receipts model an already accepted authority plan, not admission.
function acceptedReply(step, content, previousEntryDigest) {
    const outcome = { status: "ok", value: { action: "accept", content } };
    const receipt = {
        sessionId: attach.sessionId,
        taskId: attach.taskId,
        pullId: `pull-${step.actionIndex}`,
        resolutionOffset: String(step.actionIndex + 1),
        status: "accepted",
        outcomeDigest: canonicalDigest(outcome),
    };
    const body = {
        type: "operation",
        actionIndex: step.actionIndex,
        descriptorKind: step.descriptor.kind,
        descriptorDigest: canonicalDigest(step.descriptor),
        previousEntryDigest,
        outcome,
        receipt,
    };
    return {
        reply: { outcome, receipt, replayed: true },
        entry: {
            ...body,
            entryDigest: canonicalDigest({
                replayChainSeed: seed,
                previousEntryDigest,
                entryWithoutEntryDigest: body,
            }),
        },
    };
}

for (const placement of ["local", "worker"]) {
    const makeTransport = () =>
        placement === "local"
            ? localHootTransport()
            : createWorkerTransport(new URL("./fixtures/bootstrap.mjs", import.meta.url));
    // Mechanical observation of serialized envelopes, standing in for the
    // principal's checkpoint persistence. Execution handles remain private.
    function executor(envelopes) {
        const transport = makeTransport();
        return createExecutor({
            *connect() {
                const connection = yield* transport.connect();
                return {
                    *exchange(command) {
                        const response = yield* connection.exchange(command);
                        if (response.kind === "boundary") {
                            envelopes.push(response);
                        }
                        return response;
                    },
                    close: () => connection.close(),
                };
            },
        });
    }

    let recovery;
    let expectedFrontier;
    // First instance acquires a hold, accepts approval, and parks in cleanup.
    // Save the earlier checkpoint so restoration must replay a suffix.
    await run(function* () {
        const envelopes = [];
        const executionState = yield* executor(envelopes).start({ attach }, null);
        assert.equal(executionState.boundary.request.descriptor.key, "reserve");
        const hold = acceptedReply(executionState.boundary.request, "hold-17", seed);
        const approval = yield* executionState.execution.resume(
            executionState.boundary.suspensionId,
            hold.reply,
        );
        assert.equal(approval.request.descriptor.key, "approve");
        const checkpoint = envelopes.at(-1).checkpoint;
        assert.equal(checkpoint.kind, "continuation");
        const approved = acceptedReply(approval.request, "approved", hold.entry.entryDigest);
        expectedFrontier = yield* executionState.execution.resume(
            approval.suspensionId,
            approved.reply,
        );
        assert.equal(expectedFrontier.request.descriptor.key, "release");
        recovery = {
            attach: { ...attach, executionEpoch: 2 },
            checkpoint: {
                ...checkpoint,
                resumeAfter: { actionIndex: 0, replayChainDigest: hold.entry.entryDigest },
            },
            replay: [hold.entry, approved.entry],
            replayChainSeed: seed,
            replayChainDigest: approved.entry.entryDigest,
            replayedThroughActionIndex: 1,
        };
        yield* executionState.execution.dispose();
    });

    // Fresh scope/connection (and fresh worker for worker placement). Prove
    // checkpoint + suffix and full replay reach the same cleanup continuation.
    for (const replayOnly of [false, true]) {
        await run(function* () {
            const envelopes = [];
            const executionState = yield* executor(envelopes).start({ recovery, replayOnly }, null);
            assert.deepEqual(executionState.boundary, expectedFrontier);
            const events = envelopes[0].events;
            assert.equal(events.filter((event) => event === "restore").length, replayOnly ? 0 : 1);
            assert.equal(events.filter((event) => event === "start").length, replayOnly ? 1 : 0);
            assert.equal(events.filter((event) => event === "resume").length, replayOnly ? 2 : 1);
            assert.deepEqual(
                events.filter((event) => event.startsWith("recover:")),
                ["recover:before", "recover:after"],
            );
            assert.equal(envelopes[0].checkpoint.kind, replayOnly ? "replay" : "continuation");
            const released = acceptedReply(
                executionState.boundary.request,
                "released",
                recovery.replayChainDigest,
            );
            const completed = yield* executionState.execution.resume(
                executionState.boundary.suspensionId,
                released.reply,
            );
            assert.deepEqual(completed, { kind: "completed", value: "Caller received: approved" });
            yield* executionState.execution.dispose();
        });
    }
    console.log(
        `PASS ${placement}: real Hoot checkpoint, fresh connection, suffix/full replay parity, cleanup completion`,
    );

    // Middleware in one connection must not change a sibling connection's policy.
    await run(function* () {
        yield* scoped(function* () {
            const replay = [],
                accelerated = [];
            const first = yield* executor(replay).start({ recovery, replayOnly: true }, null);
            const second = yield* executor(accelerated).start({ recovery }, null);
            assert.equal(replay[0].checkpoint.kind, "replay");
            assert.equal(accelerated[0].checkpoint.kind, "continuation");
            yield* first.execution.dispose();
            yield* second.execution.dispose();
        });
    });
    console.log(`PASS ${placement}: connection recovery policy isolation`);

    // Mandatory validation remains in recoverProgram, outside replaceable policy.
    // A corrupt supported snapshot also fails rather than silently replaying.
    for (const [invalid, expectedError] of [
        [{ ...recovery, replayChainDigest: "wrong" }, /Recovery history differs from planned head/],
        [
            { ...recovery, checkpoint: { ...recovery.checkpoint, state: null } },
            /Checkpoint identity or position differs/,
        ],
    ]) {
        await assert.rejects(
            run(function* () {
                yield* executor([]).start({ recovery: invalid }, null);
            }),
            expectedError,
        );
    }
    console.log(`PASS ${placement}: invalid plan and corrupt snapshot reject across transport`);
}
