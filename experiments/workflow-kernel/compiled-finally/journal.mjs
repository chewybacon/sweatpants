// Research journal driver. Trusted JSON inputs; no database or concurrent writer integration.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { start, run } from "./engine.mjs";
import { schemas as defaultSchemas, textV1, parseRegisteredSchema } from "./schemas.mjs";
const canonical = (x) =>
    x === null || typeof x !== "object"
        ? JSON.stringify(x)
        : Array.isArray(x)
          ? "[" + x.map(canonical).join(",") + "]"
          : "{" +
            Object.keys(x)
                .sort()
                .map((k) => JSON.stringify(k) + ":" + canonical(x[k]))
                .join(",") +
            "}";
export const hash = (x) => createHash("sha256").update(canonical(x)).digest("hex");
export const copy = (x) => JSON.parse(JSON.stringify(x));
const check = (ok, message) => {
    if (!ok) {
        throw Error(message);
    }
};
const equal = (a, b) => hash(a) === hash(b);
export const COMPLETION_POLICY = "validated-output-v1";
export const ENGINE_ID = createHash("sha256")
    .update(readFileSync(new URL("./engine.mjs", import.meta.url)))
    .digest("hex");

function load(record, registry, schemas) {
    const a = registry[record.artifact];
    check(a, "Missing pinned artifact");
    const { id, ...body } = a;
    check(id === record.artifact && hash(body) === id, "Artifact integrity failure");
    check(a.engine === ENGINE_ID, "Pinned evaluator unavailable");
    check(a.format === 2, "Unsupported artifact format");
    check(a.completionPolicy === COMPLETION_POLICY, "Unsupported completion policy");
    for (const [digest, descriptor] of Object.entries(a.schemaDescriptors)) {
        const entry = schemas.get(digest);
        check(entry, "Missing pinned schema validator");
        check(equal(entry.descriptor, descriptor), "Schema descriptor mismatch");
    }
    return a;
}
function append(record, event) {
    const body = { ...event, previous: record.events.at(-1)?.hash ?? null };
    record.events.push({ ...body, hash: hash(body) });
}
function verify(record) {
    let previous = null;
    for (const event of record.events) {
        const { hash: claimed, ...body } = event;
        check(body.previous === previous && hash(body) === claimed, "Journal integrity failure");
        previous = claimed;
    }
}
function validateValue(schemas, digest, value, role) {
    const checked = parseRegisteredSchema(schemas, digest, value);
    check(checked.status === "ok", `${role} schema validation failed: ${checked.status}`);
    check(equal(checked.value, value), "Schema normalization is unsupported in this spike");
}
function settleCompletion(ctx) {
    if (!ctx.artifact.boundary || ctx.output?.outcome?.kind !== "returned") {
        return;
    }
    const digest = ctx.artifact.boundary.output;
    const checked = parseRegisteredSchema(ctx.schemas, digest, ctx.output.outcome.value);
    if (checked.status === "invalid") {
        // A contract failure belongs to the invocation, not to an authored throw.
        // Keep diagnostics stable and avoid copying potentially sensitive output.
        const outcome = { kind: "failed", code: "output_schema_invalid", schema: digest };
        ctx.state.outcome = outcome;
        ctx.output.outcome = outcome;
        return;
    }
    // Missing/broken validators are infrastructure failures, not bad user output.
    check(checked.status === "ok", `output schema validation failed: ${checked.status}`);
    check(
        equal(checked.value, ctx.output.outcome.value),
        "Schema normalization is unsupported in this spike",
    );
}
function validateInput(ctx, input) {
    check(
        Object.keys(input).length === 1 &&
            (Object.hasOwn(input, "reply") ||
                Object.hasOwn(input, "error") ||
                input.cancel === true),
        "Invalid resume command",
    );
    if (input.cancel === true) {
        return;
    }
    const role = Object.hasOwn(input, "reply") ? "reply" : "error";
    const contract = ctx.artifact.contracts[ctx.pending?.site];
    check(contract, "Missing pending effect contract");
    const checked = parseRegisteredSchema(ctx.schemas, contract[role], input[role]);
    check(checked.status === "ok", `${role} schema validation failed: ${checked.status}`);
    check(equal(checked.value, input[role]), "Schema normalization is unsupported in this spike");
}
function apply(ctx, input) {
    validateInput(ctx, input);
    const output = run(ctx.artifact.compiled.program, ctx.state, input);
    if (output.waiting) {
        check(
            ctx.pending && equal(output.effect, ctx.pending.request),
            "Shielded cancellation changed pending request",
        );
        delete ctx.output;
    } else {
        ctx.pending = null;
        ctx.output = output;
    }
}
function checkpoint(record, ctx) {
    check(!ctx.output, "Unpublished execution output");
    const body = {
        format: 1,
        artifact: record.artifact,
        cursor: record.events.length,
        journalHash: record.events.at(-1)?.hash ?? null,
        state: ctx.state,
        pending: ctx.pending,
    };
    record.checkpoint = { ...copy(body), checksum: hash(body) };
}
function publish(record, ctx) {
    if (!ctx.output) {
        return;
    }
    if (ctx.state.status === "done") {
        settleCompletion(ctx);
        append(record, { kind: "done", outcome: ctx.output.outcome });
        ctx.pending = null;
    } else {
        check(ctx.state.status === "waiting", "Expected effect boundary");
        const request = {
            kind: "request",
            id: `${record.invocation}:${record.events.length}`,
            site: ctx.state.site,
            contract: ctx.artifact.contracts[ctx.state.site],
            request: ctx.output.effect,
        };
        append(record, request);
        ctx.pending = request;
    }
    delete ctx.output;
}
export function recover(record, registry, schemas = defaultSchemas) {
    verify(record);
    const a = load(record, registry, schemas);
    let ctx,
        cursor = 0,
        input = null;
    if (a.boundary) {
        check(record.events[0]?.kind === "started", "Missing invocation input");
        input = record.events[0].input;
        validateValue(schemas, a.boundary.input, input, "input");
        cursor = 1;
    }
    if (record.checkpoint) {
        const { checksum, ...c } = record.checkpoint;
        check(c.format === 1 && hash(c) === checksum, "Checkpoint integrity failure");
        check(
            c.artifact === a.id &&
                c.state.program === a.compiled.program.id &&
                c.state.version === 2,
            "Checkpoint program mismatch",
        );
        check(
            Number.isInteger(c.cursor) && c.cursor > 0 && c.cursor <= record.events.length,
            "Invalid checkpoint cursor",
        );
        check(c.journalHash === record.events[c.cursor - 1].hash, "Checkpoint journal mismatch");
        if (c.pending) {
            check(
                c.pending.site === c.state.site &&
                    equal(c.pending.contract, a.contracts[c.pending.site]),
                "Checkpoint effect contract mismatch",
            );
        }
        ctx = { artifact: a, schemas, state: copy(c.state), pending: copy(c.pending) };
        cursor = c.cursor;
    } else {
        ctx = {
            artifact: a,
            schemas,
            state: start(a.compiled.program, a.boundary ? copy(input) : null),
            pending: null,
        };
        ctx.output = run(a.compiled.program, ctx.state);
    }
    for (const event of record.events.slice(cursor)) {
        if (event.kind === "request") {
            check(
                ctx.output &&
                    ctx.state.status === "waiting" &&
                    ctx.state.site === event.site &&
                    equal(ctx.output.effect, event.request) &&
                    equal(a.contracts[event.site], event.contract),
                "Replay request mismatch",
            );
            ctx.pending = {
                kind: "request",
                id: event.id,
                site: event.site,
                contract: copy(event.contract),
                request: copy(event.request),
            };
            delete ctx.output;
        } else if (event.kind === "command") {
            check(!ctx.output && ctx.pending?.id === event.requestId, "Stale effect identity");
            apply(ctx, event.input);
        } else if (event.kind === "done") {
            settleCompletion(ctx);
            check(
                ctx.output &&
                    ctx.state.status === "done" &&
                    equal(ctx.output.outcome, event.outcome),
                "Replay completion mismatch",
            );
            delete ctx.output;
        } else {
            throw Error("Unknown journal event");
        }
    }
    return ctx;
}
export function create(a, invocation, schemas = defaultSchemas, input = {}) {
    const record = { format: 1, artifact: a.id, invocation, events: [] };
    load(record, { [a.id]: a }, schemas);
    if (a.boundary) {
        validateValue(schemas, a.boundary.input, input, "input");
        append(record, { kind: "started", input: copy(input) });
    }
    const ctx = {
        artifact: a,
        schemas,
        state: start(a.compiled.program, a.boundary ? copy(input) : null),
        pending: null,
    };
    ctx.output = run(a.compiled.program, ctx.state);
    publish(record, ctx);
    checkpoint(record, ctx);
    return record;
}
// Split append from repair deliberately: tests interrupt between these durable writes.
export function appendCommand(
    record,
    registry,
    { id, requestId, input, revision },
    schemas = defaultSchemas,
) {
    const ctx = recover(record, registry, schemas);
    const prior = record.events.find((e) => e.kind === "command" && e.id === id);
    if (prior) {
        check(
            prior.requestId === requestId && equal(prior.input, input),
            "Conflicting duplicate command",
        );
        return copy(record);
    }
    check(record.events.length === revision, "Revision conflict");
    check(!ctx.output && ctx.pending?.id === requestId, "Stale effect identity");
    check(
        Object.keys(input).length === 1 &&
            (Object.hasOwn(input, "reply") ||
                Object.hasOwn(input, "error") ||
                input.cancel === true),
        "Invalid resume command",
    );
    validateInput(ctx, input);
    const next = copy(record);
    append(next, { kind: "command", id, requestId, input: copy(input) });
    return next;
}
export function repair(record, registry, schemas = defaultSchemas) {
    const next = copy(record),
        ctx = recover(next, registry, schemas);
    publish(next, ctx);
    checkpoint(next, ctx);
    return next;
}
