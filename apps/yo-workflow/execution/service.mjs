import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createHootProgram } from "../../../experiments/workflow-kernel/hoot-composition/driver.mjs";
import { reviewDraft } from "../../../experiments/workflow-kernel/tsdown-authoring/dist/review-draft.workflow.mjs";
import {
    createJournal,
    createMemoryExecutionStore,
    createCapabilityKeyring,
    driveProgramDriverActivation,
} from "../../../packages/journal-authority/dist/index.js";
import {
    ANY_JSON_SCHEMA_DESCRIPTOR as schema,
    ProgramDriverRegistryContext,
} from "../../../packages/durable-execution/dist/index.js";
import {
    defineDurableEffect,
    createDurableEffectRegistration,
} from "../../../packages/durable-effects/dist/authoring.js";
import {
    DurableEffectRegistryContext,
    createDurableEffectRegistry,
    DurableEffects,
    ProgramPlacementContext,
} from "../../../packages/durable-effects/dist/index.js";
const sendDefinition = defineDurableEffect({
    name: "send_announcement",
    version: "1",
    inputSchema: schema,
    outputSchema: schema,
    retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});
const { run } = createRequire(new URL("../../../package.json", import.meta.url))("effection");

export const developerSource = reviewDraft.source;
const caller = `(define (workflow input) (review_draft input))\n(workflow %input)`;
function buildProgram(callerSource) {
    return createHootProgram({
        source: `(registered-program
          (${reviewDraft.scheme})
          ((review_draft compiled ${reviewDraft.entry} (#f)) (send_announcement host))
          (${callerSource}))`,
        contract: {
            programId: "inspect-confirmation",
            version: "1",
            inputSchema: schema,
            outputSchema: schema,
            effects: { send_announcement: sendDefinition },
            elicits: { approval: { response: schema }, cleanup: { response: schema } },
            capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
        },
        bindOperation(request, site) {
            if (
                Array.isArray(request) &&
                request[0] === "effect" &&
                request[1] === sendDefinition.name &&
                request[2] === "1"
            ) {
                return {
                    kind: "effect",
                    name: sendDefinition.name,
                    version: "1",
                    input: request[3],
                    resolver: { audience: "host:announcements" },
                };
            }
            if (
                !Array.isArray(request) ||
                request[0] !== "elicit" ||
                !["approval", "cleanup"].includes(request[1])
            )
                throw Error("Unsupported inspection workflow effect");
            return {
                kind: "elicit",
                key: request[1],
                message: request[2],
                response: schema,
                binding: { id: site },
            };
        },
    });
}

// Local playground composition over production journal/driver APIs. No test transport
// or model simulator: the developer fixture is run directly and the UI supplies replies.
export function createExecutionService({ author } = {}) {
    const sessions = new Map();
    const keyring = createCapabilityKeyring("execution-playground", [
        { keyId: "local", secret: randomUUID().repeat(2) },
    ]);
    function trace(session, kind, data = {}) {
        session.trace.push({
            sequence: session.nextEvent++,
            at: new Date().toISOString(),
            kind,
            ...data,
        });
        if (session.trace.length > 100) session.trace.shift();
    }
    function observe(session, kind, data) {
        if (data?.inspection) session.inspection = data.inspection;
        trace(session, `kernel.${kind}`, {
            ...(data?.durationMs === undefined ? {} : { durationMs: data.durationMs }),
            ...(data?.boundary ? { data: data.boundary } : {}),
            ...(data?.snapshot ? { data: data.snapshot } : {}),
            ...(data?.reply ? { data: data.reply } : {}),
        });
    }
    function view(session) {
        return structuredClone({
            id: session.id,
            revision: session.revision,
            status: session.result?.state ?? "idle",
            result: session.result ?? null,
            inspection: session.inspection ?? null,
            checkpoint: session.checkpoint ?? null,
            restoration: session.restoration ?? null,
            pending: session.pending ?? null,
            trace: session.trace,
            outbox: [...session.outbox.values()],
            developerSource,
            schemeSource: session.program.artifact.code,
            compiledSites: reviewDraft.debug.sites,
        });
    }
    return {
        get(id) {
            const session = sessions.get(id);
            if (!session)
                throw Error("Execution not found. Local runs expire when the dev server restarts.");
            return view(session);
        },
        async command(command) {
            let session;
            if (command.action === "start") {
                if (sessions.size >= 32)
                    throw Error(
                        "Local execution limit reached. Restart the dev server to clear runs.",
                    );
                const authored = command.prompt ? await author?.(command.prompt) : caller;
                if (typeof authored !== "string" || !authored.trim())
                    throw Error("Model authoring is unavailable or returned no Scheme");
                const program = buildProgram(authored);
                session = {
                    program,
                    outbox: new Map(),
                    id: randomUUID(),
                    store: createMemoryExecutionStore(),
                    revision: 0,
                    trace: [],
                    nextEvent: 0,
                    busy: false,
                };
                sessions.set(session.id, session);
            } else {
                session = sessions.get(command.id);
                if (!session) throw Error("Execution not found");
                if (command.revision !== session.revision)
                    throw Error("Execution changed. Reload before continuing.");
            }
            const program = session.program;
            if (session.busy) throw Error("Execution is busy");
            session.busy = true;
            try {
                await run(function* () {
                    const journal = yield* createJournal(session.store, {
                        journalId: session.id,
                        keyring,
                    });
                    const attach = {
                        sessionId: session.id,
                        taskId: "root",
                        executionEpoch: 1,
                        program: {
                            id: program.manifest.programId,
                            version: "1",
                            digest: program.manifest.digest,
                        },
                        input: {
                            title: "Review the launch announcement",
                            recipient: "Sam",
                            metadata: null,
                        },
                        route: { driverKind: "hoot-composition" },
                    };
                    const driver = program.createDriver((kind, data) =>
                        observe(session, kind, data),
                    );
                    yield* ProgramDriverRegistryContext.with(
                        new Map([["hoot-composition", driver]]),
                        function* () {
                            if (command.action === "start") {
                                yield* journal.advance({
                                    type: "execution.open-task",
                                    request: {
                                        ...attach,
                                        turnId: "turn",
                                        manifest: program.manifest,
                                        attachmentId: "unattached",
                                        audience: "local-inspector",
                                    },
                                });
                                trace(session, "host.start", { data: attach.input });
                            } else {
                                if (session.result?.state !== "parked")
                                    throw Error("Execution is not waiting");
                                if (command.action === "restore") {
                                    const saved = yield* journal.exportSnapshot();
                                    const task = saved.sessions
                                        .find(([id]) => id === session.id)?.[1]
                                        .execution.tasks.find(
                                            (task) => task.taskId === attach.taskId,
                                        );
                                    const checkpoint = task?.execution.checkpoint;
                                    if (checkpoint?.kind !== "continuation")
                                        throw Error("No accepted checkpoint is available");
                                    trace(session, "host.restore-requested");
                                    const kernel = program.createKernel((kind, data) =>
                                        observe(session, kind, data),
                                    );
                                    try {
                                        const before = session.inspection.steps;
                                        const restored = yield* kernel.restore(
                                            program.artifact,
                                            checkpoint.state.backend,
                                        );
                                        if (session.inspection.steps !== before)
                                            throw Error(
                                                "Restoration changed the evaluator step count",
                                            );
                                        session.restoration = {
                                            stepsBefore: before,
                                            stepsAfter: session.inspection.steps,
                                        };
                                        trace(session, "host.restore-verified", {
                                            data: {
                                                boundary: restored.boundary,
                                                stepsBefore: before,
                                                stepsAfter: session.inspection.steps,
                                            },
                                        });
                                    } finally {
                                        yield* kernel.close();
                                    }
                                    return;
                                }
                                if (command.action === "cancel") {
                                    yield* journal.advance({
                                        type: "execution.request-cancellation",
                                        request: {
                                            sessionId: session.id,
                                            taskId: attach.taskId,
                                            reason: "Cancelled in inspector",
                                            commandId: randomUUID(),
                                        },
                                    });
                                    trace(session, "authority.cancellation-accepted");
                                } else if (command.action === "reply") {
                                    if (
                                        session.pending.key === "approval" &&
                                        !["approve", "decline"].includes(command.choice)
                                    )
                                        throw Error("Choose approve or decline");
                                    if (
                                        session.pending.key === "cleanup" &&
                                        command.choice !== "release"
                                    )
                                        throw Error("Choose release");
                                    const value = {
                                        action: "accept",
                                        content: { approved: command.choice === "approve" },
                                    };
                                    const capability = yield* journal.query({
                                        type: "pull.resolution-capability",
                                        sessionId: session.id,
                                        taskId: attach.taskId,
                                        pullId: session.result.pullId,
                                    });
                                    const accepted = yield* journal.advance({
                                        type: "execution.resolve-pull",
                                        request: {
                                            capability,
                                            audience: `user:${session.pending.key}`,
                                            outcome: { status: "ok", value },
                                        },
                                    });
                                    if (accepted.status === "rejected")
                                        throw Error(
                                            `Reply rejected by journal authority: ${JSON.stringify(accepted)}`,
                                        );
                                    trace(session, "authority.reply-accepted", { data: value });
                                } else throw Error("Unknown execution command");
                            }
                            session.result = yield* driveProgramDriverActivation({
                                authority: {
                                    command: journal.advance.bind(journal),
                                    query: journal.query.bind(journal),
                                },
                                driver,
                                attach,
                                advancement: {
                                    effects: {
                                        *route() {
                                            return "host";
                                        },
                                        *executeHost(authorization, placement) {
                                            const registry = createDurableEffectRegistry([
                                                createDurableEffectRegistration(
                                                    sendDefinition,
                                                    sendDefinition.retrySafety,
                                                    function* (input, ctx) {
                                                        if (
                                                            !input ||
                                                            typeof input !== "object" ||
                                                            typeof input.title !== "string" ||
                                                            typeof input.recipient !== "string"
                                                        ) {
                                                            return {
                                                                status: "error",
                                                                error: {
                                                                    code: "invalid_announcement",
                                                                    message:
                                                                        "Expected title and recipient strings",
                                                                },
                                                            };
                                                        }
                                                        let item = session.outbox.get(ctx.pullId);
                                                        if (!item) {
                                                            item = {
                                                                announcementId: randomUUID(),
                                                                status: "queued",
                                                                title: input.title,
                                                                recipient: input.recipient,
                                                            };
                                                            session.outbox.set(ctx.pullId, item);
                                                            trace(
                                                                session,
                                                                "host.announcement-queued",
                                                                { data: item },
                                                            );
                                                        }
                                                        return { status: "ok", value: item };
                                                    },
                                                ),
                                            ]);
                                            return yield* DurableEffectRegistryContext.with(
                                                registry,
                                                function* () {
                                                    return yield* ProgramPlacementContext.with(
                                                        placement,
                                                        function* () {
                                                            return yield* DurableEffects.operations.execute(
                                                                authorization,
                                                            );
                                                        },
                                                    );
                                                },
                                            );
                                        },
                                    },
                                },
                            });
                            const saved = yield* journal.exportSnapshot();
                            session.checkpoint =
                                saved.sessions
                                    .find(([id]) => id === session.id)?.[1]
                                    .execution.tasks.find((task) => task.taskId === attach.taskId)
                                    ?.execution.checkpoint ?? null;
                            session.restoration = null;
                            const records = yield* journal.readSession(session.id);
                            const pull =
                                session.result.state === "parked"
                                    ? records.find(
                                          (record) =>
                                              record.payload.type === "PullRequested" &&
                                              record.payload.pullId === session.result.pullId,
                                      )?.payload
                                    : null;
                            session.pending = pull
                                ? {
                                      key: pull.descriptor.key,
                                      message: pull.descriptor.message,
                                      pullId: pull.pullId,
                                  }
                                : null;
                            trace(session, `host.${session.result.state}`, {
                                data: session.result,
                            });
                        },
                    );
                });
                session.revision++;
                return view(session);
            } catch (error) {
                trace(session, "host.error", { data: { message: error.message } });
                session.revision++;
                throw error;
            } finally {
                session.busy = false;
            }
        },
    };
}
