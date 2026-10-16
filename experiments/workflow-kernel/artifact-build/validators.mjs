// Bounded portable Zod recipe. Custom code is deliberately not serializable.
import { createRequire } from "node:module";
const require = createRequire(
    new URL("../../../packages/vite-plugin/package.json", import.meta.url),
);
const { z } = require("zod");
export const ZOD_VERSION = require("zod/package.json").version;
export function encodeSchema(schema) {
    const d = schema?._zod?.def;
    if (!d) throw Error("Validator is not supported Zod");
    const checks = (d.checks ?? []).map((c) => {
        const x = c._zod.def;
        if (x.check === "min_length") return ["min", x.minimum];
        if (x.check === "max_length") return ["max", x.maximum];
        if (x.check === "greater_than" && x.inclusive) return ["min", x.value];
        if (x.check === "less_than" && x.inclusive) return ["max", x.value];
        if (x.check === "number_format" && x.format === "safeint") return ["int"];
        throw Error("Unsupported portable validator check: " + x.check);
    });
    if (d.coerce) throw Error("Schema coercion is not portable in this subset");
    let recipe;
    switch (d.type) {
        case "string":
        case "number":
            recipe = { type: d.type, checks };
            break;
        case "boolean":
        case "null":
            recipe = { type: d.type };
            break;
        case "literal":
            recipe = { type: d.type, values: [...d.values] };
            break;
        case "enum":
            recipe = { type: d.type, values: Object.values(d.entries) };
            break;
        case "optional":
        case "nullable":
            recipe = { type: d.type, inner: encodeSchema(d.innerType) };
            break;
        case "array":
            recipe = { type: d.type, element: encodeSchema(d.element), checks };
            break;
        case "union":
            recipe = { type: d.type, options: d.options.map(encodeSchema) };
            break;
        case "object": {
            if (d.catchall?._zod?.def.type !== "never")
                throw Error("Only strict object validators are portable in this subset");
            recipe = {
                type: d.type,
                shape: Object.fromEntries(
                    Object.entries(d.shape).map(([key, value]) => [key, encodeSchema(value)]),
                ),
            };
            break;
        }
        default:
            throw Error("Unsupported portable validator type: " + d.type);
    }
    // Checks on wrappers/objects/unions must never disappear unnoticed.
    if (checks.length && !["string", "number", "array"].includes(d.type))
        throw Error("Unsupported wrapper checks");
    return recipe;
}
export function decodeSchema(r) {
    let s;
    switch (r.type) {
        case "string":
            s = z.string();
            break;
        case "number":
            s = z.number();
            break;
        case "boolean":
            s = z.boolean();
            break;
        case "null":
            s = z.null();
            break;
        case "literal":
            s = z.literal(r.values);
            break;
        case "enum":
            s = z.enum(r.values);
            break;
        case "optional":
            s = decodeSchema(r.inner).optional();
            break;
        case "nullable":
            s = decodeSchema(r.inner).nullable();
            break;
        case "array":
            s = z.array(decodeSchema(r.element));
            break;
        case "union":
            s = z.union(r.options.map(decodeSchema));
            break;
        case "object":
            s = z.strictObject(
                Object.fromEntries(Object.entries(r.shape).map(([k, v]) => [k, decodeSchema(v)])),
            );
            break;
        default:
            throw Error("Unknown validator recipe");
    }
    for (const [op, value] of r.checks ?? []) {
        if (!["min", "max", "int"].includes(op) || typeof s[op] !== "function")
            throw Error("Invalid validator recipe operation");
        s = op === "int" ? s.int() : s[op](value);
    }
    return s;
}
