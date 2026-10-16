// Experimental ProgramDriver. The real journal owns all ordering/acceptance.
// cache is trusted disposable storage, never a replacement for journal replay.
import { createPullMachine, createCompiledPullTool } from "./pull-adapter.mjs";
import { hash, copy } from "../compiled-finally/journal.mjs";
import { replayProgramRecovery } from "../../../packages/durable-execution/dist/index.js";
import { canonicalDigest } from "../../../packages/foundation/dist/index.js";

export function createCompiledProgramDriver(
    bundle,
    { cache = new Map(), observe = () => {} } = {},
) {
    const tool = createCompiledPullTool(bundle),
        active = new Set();
    const pinned = {
        id: tool.manifest.programId,
        version: tool.manifest.version,
        digest: tool.manifest.digest,
    };
    function view(h) {
        const next = h.machine.frontier();
        if (next.type === "pull")
            return { type: "operation", actionIndex: h.index, descriptor: next.descriptor };
        const outcome = next.outcome;
        if (outcome.kind === "returned")
            return { type: "completed", actionIndex: h.index, value: outcome.value };
        return {
            type: "failed",
            actionIndex: h.index,
            error: {
                code:
                    outcome.kind === "cancelled" ? "program_cancelled" : "compiled_program_failed",
                message: String(outcome.value ?? outcome.kind),
            },
        };
    }
    return {
        ...replayProgramRecovery,
        evaluatorKind: "program",
        capabilities: { replay: { kind: "replay", version: 1 } },
        *manifest(program) {
            if (hash(program) !== hash(pinned)) throw Error("Pinned program unavailable");
            return tool.manifest;
        },
        *attach(request) {
            if (hash(request.program) !== hash(pinned)) throw Error("Pinned program unavailable");
            const h = {
                request: copy(request),
                index: 0,
                machine: null,
                cacheable: true,
                chain: hash({
                    session: request.sessionId,
                    task: request.taskId,
                    program: pinned,
                    input: request.input,
                }),
            };
            active.add(h);
            return {
                attachmentId: crypto.randomUUID(),
                taskId: request.taskId,
                driverKind: "compiled-spike",
                route: request.route,
                executionEpoch: request.executionEpoch,
                handle: h,
            };
        },
        *step(attachment, command) {
            const h = attachment.handle;
            if (!active.has(h)) throw Error("Attachment released");
            if (command.type === "start") {
                if (h.machine || hash(command.input) !== hash(h.request.input))
                    throw Error("Invalid start");
                h.machine = createPullMachine(bundle, command.input);
            } else if (command.type === "resume") {
                if (
                    !h.machine ||
                    command.actionIndex !== h.index ||
                    h.machine.frontier().type !== "pull"
                )
                    throw Error("Out-of-order resume");
                const r = command.receipt;
                if (
                    !r ||
                    r.sessionId !== h.request.sessionId ||
                    r.taskId !== h.request.taskId ||
                    !r.pullId ||
                    !r.resolutionOffset ||
                    !["accepted", "duplicate"].includes(r.status) ||
                    r.outcomeDigest !== canonicalDigest(command.outcome)
                )
                    throw Error("Invalid accepted resolution receipt");
                const key = hash({
                    previous: h.chain,
                    index: h.index,
                    pull: r.pullId,
                    offset: r.resolutionOffset,
                    outcome: r.outcomeDigest,
                });
                const saved = h.cacheable ? cache.get(key) : undefined;
                if (saved) {
                    h.machine = createPullMachine(bundle, h.request.input, saved);
                    observe({ type: "checkpoint-restored", index: h.index });
                } else {
                    if (command.outcome.status === "ok") h.machine.resume(command.outcome.value);
                    else if (command.outcome.status === "cancelled") h.machine.cancel();
                    else if (command.outcome.status === "error")
                        h.machine.raise(command.outcome.error.message);
                    else throw Error("Unsupported resolution outcome");
                    if (h.cacheable) {
                        cache.set(key, h.machine.capture());
                        observe({ type: "checkpoint-saved", index: h.index });
                    }
                }
                h.chain = key;
                h.index++;
            } else if (command.type === "cancel") {
                if (!h.machine) throw Error("Program not started");
                h.machine.cancel();
                h.cacheable = false;
                // Unaccepted live cancellation must never poison a receipt-keyed checkpoint.
                observe({ type: "logical-cancel" });
            } else throw Error("Unsupported driver command: " + command.type);
            return view(h);
        },
        *shutdown(attachment, reason) {
            if (active.delete(attachment.handle)) observe({ type: "activation-discarded", reason });
            // No stepping and no cleanup here: cancellation is an explicit command.
        },
    };
}
