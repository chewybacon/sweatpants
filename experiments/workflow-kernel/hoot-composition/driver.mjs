import fs from "node:fs";
import { createRequire } from "node:module";
import { loadMachine } from "./machine.mjs";
import { source } from "./fixture.mjs";
import { createKernelProgramBackend } from "../../../packages/program-backend-kernel/dist/index.js";
import { assertKernelCompatibility } from "../../../packages/workflow-kernel/dist/index.js";
import { canonicalDigest, sha256Bytes } from "../../../packages/foundation/dist/index.js";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "../../../packages/durable-execution/dist/index.js";
import { createWorkflowProgramDriver } from "../../../packages/journal-authority/dist/index.js";
const { call } = createRequire(new URL("../../../package.json", import.meta.url))("effection");
const wasm = fs.readFileSync(
    new URL("../../../.artifacts/hoot-composition/kernel.wasm", import.meta.url),
);
const identity = {
    kind: "hoot-composition-spike",
    version: sha256Bytes(wasm),
    programFormat: "workflow-scheme-spike-1",
    snapshotFormat: "workflow-state-v3",
};
const fixtureContract = {
    programId: "hoot-composition",
    version: "1",
    inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    effects: {},
    elicits: Object.fromEntries(
        ["reserve", "approve", "release"].map((key) => [
            key,
            { response: ANY_JSON_SCHEMA_DESCRIPTOR },
        ]),
    ),
    capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};
function kernel(observe, source, digest) {
    let machine = null,
        closed = false;
    function check() {
        if (!machine || closed) {
            throw Error("Hoot instance disposed");
        }
    }
    function boundary(step) {
        if (step.kind === "effect") {
            return { kind: "effect", site: step.site, request: step.value };
        }
        if (step.kind === "returned" || step.kind === "thrown") {
            return { kind: "terminal", outcome: { kind: step.kind, value: step.value } };
        }
        if (step.kind === "cancelled") {
            return { kind: "terminal", outcome: { kind: "cancelled" } };
        }
        throw Error("Unknown Hoot boundary");
    }
    function transition(event, action) {
        const started = performance.now();
        const result = boundary(action());
        observe(event, {
            boundary: result,
            inspection: machine.inspect(),
            durationMs: performance.now() - started,
        });
        return result;
    }
    const execution = {
        *resume(reply) {
            check();
            return transition("resume", () =>
                reply.kind === "throw" ? machine.reject(reply.value) : machine.resume(reply.value),
            );
        },
        *cancel() {
            check();
            return transition("cancel", () => machine.cancel());
        },
        *capture() {
            check();
            const state = machine.capture();
            observe("capture", { bytes: new TextEncoder().encode(state).length });
            return { kernel: identity, programDigest: digest, state };
        },
        *dispose() {
            if (machine) {
                machine = null;
                observe("dispose");
            }
        },
    };
    function validate(program, snapshot) {
        if (closed || machine) {
            throw Error("Kernel already used");
        }
        assertKernelCompatibility(identity, program, snapshot);
        if (program.digest !== digest || program.code !== source) {
            throw Error("Wrong program");
        }
    }
    return {
        identity,
        *start(program, input) {
            validate(program);
            machine = yield* call(loadMachine);
            return { execution, boundary: transition("start", () => machine.start(source, input)) };
        },
        *restore(program, snapshot) {
            validate(program, snapshot);
            if (typeof snapshot.state !== "string") {
                throw Error("Invalid snapshot");
            }
            machine = yield* call(loadMachine);
            return {
                execution,
                boundary: transition("restore", () => machine.restore(source, snapshot.state)),
            };
        },
        *close() {
            yield* execution.dispose();
            closed = true;
        },
    };
}
export function createHootProgram({ source, contract, bindOperation }) {
    const digest = canonicalDigest({ source, identity, contract });
    const manifest = { ...contract, digest };
    return {
        manifest,
        artifact: { digest, code: source, kernel: identity },
        createKernel(observe = () => {}) {
            return kernel(observe, source, digest);
        },
        createDriver(observe = () => {}) {
            const driver = createWorkflowProgramDriver(
                createKernelProgramBackend({
                    *manifest(program) {
                        if (program.digest !== digest) throw Error("Manifest unavailable");
                        return manifest;
                    },
                    kernelIdentity: identity,
                    *createKernel() {
                        return kernel(observe, source, digest);
                    },
                    *loadProgram(requested) {
                        if (requested !== digest) {
                            throw Error("Program unavailable");
                        }
                        return { digest, code: source, kernel: identity };
                    },
                    bindOperation,
                }),
            );
            return driver;
        },
    };
}
const fixture = createHootProgram({
    source,
    contract: fixtureContract,
    bindOperation(request, site) {
        if (
            !Array.isArray(request) ||
            request[0] !== "elicit" ||
            !fixtureContract.elicits[request[1]]
        ) {
            throw Error("Unsupported fixture effect");
        }
        return {
            kind: "elicit",
            key: request[1],
            message: request[2] ?? request[1],
            response: ANY_JSON_SCHEMA_DESCRIPTOR,
            binding: { id: site },
        };
    },
});
export const { manifest, createDriver: createHootDriver } = fixture;
