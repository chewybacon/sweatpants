import { call } from "effection";
import { hootLinker, HOOT_PROGRAM_FORMAT } from "./linker.mts";

/** Current Hoot composition root. The app consumes validation, linking and preparation seams. */
export function createHootAuthoring({ loadMachine, createProgram }) {
    /** @type {import('../../../packages/workflow-kernel/src/index.ts').WorkflowSourceValidator} */
    const sourceValidator = {
        language: "scheme",
        *validate(source) {
            if (source.language !== "scheme") return "Hoot requires Scheme caller source";
            const machine = yield* call(loadMachine);
            return machine.validate(source.text);
        },
    };
    return {
        linker: hootLinker,
        sourceValidator,
        createProgram({ implementation, ...options }) {
            if (implementation.format !== HOOT_PROGRAM_FORMAT || typeof implementation.payload !== "string")
                throw Error("Incompatible Hoot program implementation");
            return createProgram({ ...options, source: implementation.payload });
        },
    };
}
