import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse } from "../continuation-compiler/engine.mjs";
const { Scheme } = createRequire(import.meta.url)(
    "../../../packages/scheme-runtime/generated/reflect.cjs",
);
const wasm = fileURLToPath(
    new URL("../../../.artifacts/hoot-composition/kernel.wasm", import.meta.url),
);
const reflection = fileURLToPath(
    new URL("../../../packages/scheme-runtime/generated/", import.meta.url),
);
function encode(value) {
    if (typeof value === "string" || typeof value === "number") {
        return JSON.stringify(value);
    }
    if (typeof value === "boolean") {
        return value ? "#t" : "#f";
    }
    if (value && !Array.isArray(value) && typeof value === "object") {
        return `(${Object.entries(value)
            .map(([key, item]) => `(${JSON.stringify(key)} . ${encode(item)})`)
            .join(" ")})`;
    }
    throw Error("Unsupported experiment reply");
}
export function verifyBuild() {
    const record = JSON.parse(
        fs.readFileSync(
            new URL("../../../.artifacts/hoot-composition/manifest.json", import.meta.url),
            "utf8",
        ),
    );
    const paths = {
        evaluator: "./evaluator.scm",
        build: "./build.py",
        toolchain: "../../../packages/scheme-runtime/toolchain.json",
        meter: "../../../packages/scheme-runtime/scripts/meter.scm",
        wasm: "../../../.artifacts/hoot-composition/kernel.wasm",
    };
    for (const [key, path] of Object.entries(paths)) {
        const digest = createHash("sha256")
            .update(fs.readFileSync(new URL(path, import.meta.url)))
            .digest("hex");
        if (digest !== record[key]) {
            throw Error(`Stale Hoot experiment: rebuild ${key}`);
        }
    }
}
export async function loadMachine() {
    verifyBuild();
    const procedures = await Scheme.load_main(wasm, { reflect_wasm_dir: reflection });
    function call(index, ...args) {
        procedures.fuel.value = 100_000_000n;
        return procedures[index]
            .call(...args)
            .map((value) =>
                value?.constructor?.name === "MutableString"
                    ? value.reflector.string_value(value)
                    : value,
            );
    }
    function boundary(values) {
        const [kind, site, data] = values;
        return { kind, site, value: parse(data)[0] };
    }
    return {
        start: (source) => boundary(call(0, source)),
        resume: (value) => boundary(call(1, encode(value))),
        reject: (error) => boundary(call(5, encode(error))),
        cancel: () => boundary(call(2)),
        capture: () => call(3)[0],
        restore: (source, snapshot) => boundary(call(4, source, snapshot)),
    };
}
