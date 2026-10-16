// Experimental bridge to the real DurableProgramContext.pull contract.
// No journal writes: the enclosing host owns acceptance and replay.
import {
    createGeneratedPinnedDurableProgram,
    generateProgramArtifactIdentity,
    PROGRAM_ARTIFACT_IDENTITY_FORMAT,
    PROGRAM_ARTIFACT_GENERATOR_VERSION,
} from "../../../packages/durable-execution/dist/index.js";
import { loadBundle } from "./load.mjs";
import { start, run } from "../compiled-finally/engine.mjs";
import { hash, copy } from "../compiled-finally/journal.mjs";
import { parseRegisteredSchema } from "../compiled-finally/schemas.mjs";

export function createPullMachine(bundle, input, snapshot) {
    const { artifact, schemas } = loadBundle(bundle);
    const validate = (digest, value) => {
        const result = parseRegisteredSchema(schemas, digest, value);
        if (result.status !== "ok" || hash(result.value) !== hash(value))
            throw Error("Compiled boundary validation failed");
    };
    validate(artifact.boundary.input, input);
    let state;
    if (snapshot) {
        const { checksum, ...body } = snapshot;
        if (checksum !== hash(body) || body.artifact !== artifact.id || body.input !== hash(input))
            throw Error("Continuation identity mismatch");
        state = copy(body.state);
        if (
            state.program !== artifact.compiled.program.id ||
            !["waiting", "done"].includes(state.status)
        )
            throw Error("Invalid continuation boundary");
    } else {
        state = start(artifact.compiled.program, copy(input));
        run(artifact.compiled.program, state);
    }
    function frontier() {
        if (state.status === "done") {
            if (state.outcome.kind === "returned")
                validate(artifact.boundary.output, state.outcome.value);
            return { type: "terminal", outcome: copy(state.outcome) };
        }
        const binding = artifact.tool.elicits[state.site];
        const request = state.pendingEffect;
        if (
            !binding ||
            !Array.isArray(request) ||
            request[0] !== "elicit" ||
            request[1] !== binding.key
        )
            throw Error("Unsupported compiled pull");
        const options = request[2];
        if (
            !options ||
            typeof options.message !== "string" ||
            Object.keys(options).some((k) => k !== "message")
        )
            throw Error("This adapter supports message-only elicit requests");
        return {
            type: "pull",
            descriptor: {
                kind: "elicit",
                key: binding.key,
                message: options.message,
                response: copy(artifact.manifest.elicits[binding.key].response),
                binding: { id: binding.binding },
            },
        };
    }
    return {
        frontier,
        resume(value) {
            if (state.status !== "waiting") throw Error("No pending pull");
            validate(artifact.contracts[state.site].reply, value);
            run(artifact.compiled.program, state, { reply: copy(value) });
            return frontier();
        },
        raise(error) {
            if (state.status !== "waiting") throw Error("No pending pull");
            validate(artifact.contracts[state.site].error, error);
            run(artifact.compiled.program, state, { error: copy(error) });
            return frontier();
        },
        cancel() {
            run(artifact.compiled.program, state, { cancel: true });
            return frontier();
        },
        // Caller must fence this checkpoint to its authority cursor before persisting.
        capture() {
            const body = { artifact: artifact.id, input: hash(input), state: copy(state) };
            return { ...body, checksum: hash(body) };
        },
    };
}

// Same factory signature as DurableTool.program; this is a replay bridge.
// Explicit cancellation/checkpoint installation into the production driver is
// intentionally not implied by the generator wrapper.
export function createCompiledPullProgram(bundle) {
    return function* program(input, context) {
        const machine = createPullMachine(bundle, input);
        let next = machine.frontier();
        while (next.type === "pull") {
            let reply;
            try {
                reply = yield* context.pull(next.descriptor);
            } catch (error) {
                next = machine.raise(error);
                continue;
            }
            next = machine.resume(reply);
        }
        if (next.outcome.kind === "returned") return next.outcome.value;
        if (next.outcome.kind === "thrown") throw next.outcome.value;
        throw Error("Unsupported compiled terminal outcome: " + next.outcome.kind);
    };
}

// Use the existing SDK/runtime artifact-identity constructor, not a second
// convention for published program digests.
export function createCompiledPullTool(bundle) {
    const { artifact } = loadBundle(bundle);
    const identity = generateProgramArtifactIdentity({
        format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
        generatorVersion: PROGRAM_ARTIFACT_GENERATOR_VERSION,
        manifest: artifact.manifest,
        implementationArtifactDigest: artifact.id,
        resourcePackageDigests: [],
    });
    return createGeneratedPinnedDurableProgram(identity, createCompiledPullProgram(bundle));
}
