import { projectHootInspection } from "./inspection.mts";
import { parse } from "../scheme-data/read.mjs";

// Debug projection of evaluator-owned state. Never used to authorize recovery.
function display(value) {
    if (Array.isArray(value)) {
        if (value[0]?.sym === "closure") return `λ ${value[4]?.sym} → environment ${value[3]}`;
        if (value[0]?.sym === "tool") return `registered tool ${value[1]?.sym}`;
        if (value[0]?.sym === "primitive") return `built-in ${value[1]?.sym}`;
        return `(${value.map(display).join(" ")})`;
    }
    if (value && typeof value === "object" && "sym" in value) return value.sym;
    return JSON.stringify(value);
}
export function inspectSnapshot(snapshot, boundary) {
    const state = parse(snapshot)[0];
    if (state?.[0]?.sym !== "workflow-state-v3") throw Error("Unknown inspection format");
    const frames = state[4].map((frame, index) => ({
        index,
        kind: frame[0].sym,
        detail: display(frame),
    }));
    return {
        execution: projectHootInspection(state, boundary),
        mode: state[5].sym,
        site: state[8] === false ? null : state[8][0],
        steps: state[10],
        cancellationRequested: state[11],
        snapshotBytes: new TextEncoder().encode(snapshot).length,
        currentEnvironment: state[7],
        calls: state[4]
            .filter((f) => f[0].sym === "call")
            .map((f) => f[1].sym)
            .reverse(),
        frames,
        environments: state[2].map(([id, parent, bindings]) => ({
            id,
            parent: parent === false ? null : parent,
            bindings: bindings.map(([name, ...rest]) => ({
                name: name.sym,
                value: display(rest[0]?.sym === "." ? rest[1] : rest),
            })),
        })),
        cleanups: state[4].flatMap((frame) => {
            if (frame[0].sym === "scope")
                return [
                    {
                        kind: "registered",
                        scope: display(frame[1]),
                        remaining: frame[2].map(display),
                        completion: null,
                    },
                ];
            if (frame[0].sym === "cleanup")
                return [
                    {
                        kind: "running",
                        scope: null,
                        remaining: frame[1].map(display),
                        completion: `${display(frame[2])}: ${display(frame[3])}`,
                    },
                ];
            if (frame[0].sym === "after-finally")
                return [
                    {
                        kind: "finally",
                        scope: null,
                        remaining: [],
                        completion: `${display(frame[1])}: ${display(frame[2])}`,
                    },
                ];
            return [];
        }),
    };
}
