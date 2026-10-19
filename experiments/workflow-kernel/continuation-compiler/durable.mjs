// Trusted-input research harness. This is not a database adapter or security boundary.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const ENGINE_ID = createHash("sha256")
    .update(readFileSync(new URL("./engine.mjs", import.meta.url)))
    .digest("hex");
import { compile, start, run } from "./engine.mjs";
export const copy = (x) => JSON.parse(JSON.stringify(x));
function canonical(x) {
    if (x === null || typeof x !== "object") {
        return JSON.stringify(x);
    }
    if (Array.isArray(x)) {
        return "[" + x.map(canonical).join(",") + "]";
    }
    return (
        "{" +
        Object.keys(x)
            .sort()
            .map((k) => JSON.stringify(k) + ":" + canonical(x[k]))
            .join(",") +
        "}"
    );
}
export const hash = (x) => createHash("sha256").update(canonical(x)).digest("hex");
const equal = (a, b) => hash(a) === hash(b);
function check(ok, message) {
    if (!ok) {
        throw Error(message);
    }
}
export function valid(schema, v) {
    switch (schema.type) {
        case "string":
            return typeof v === "string";
        case "integer":
            return Number.isSafeInteger(v);
        case "enum":
            return schema.values.some((x) => equal(x, v));
        case "null":
            return v === null;
        default:
            throw Error("Unsupported schema");
    }
}
export function artifact(source, contracts) {
    const program = compile(source);
    const labels = program.functions.flatMap((f) =>
        f.code.filter((i) => i[0] === "yield").map((i) => i[1]),
    );
    check(
        labels.every((x) => typeof x === "string"),
        "Durable yields require explicit labels",
    );
    check(new Set(labels).size === labels.length, "Duplicate yield label");
    check(
        labels.every((x) => contracts[x]),
        "Missing reply contract",
    );
    const body = { format: 1, engine: ENGINE_ID, program, contracts };
    return { ...body, id: hash(body) };
}
function load(registry, id) {
    const a = registry[id];
    check(a, "Missing pinned artifact");
    const { id: claimed, ...body } = a;
    check(claimed === id && hash(body) === id, "Artifact integrity failure");
    check(a.engine === ENGINE_ID, "Pinned evaluator unavailable");
    return a;
}
function append(r, event) {
    const previous = r.events.at(-1)?.hash ?? null;
    const body = { ...event, previous };
    r.events.push({ ...body, hash: hash(body) });
}
function verify(r) {
    let prev = null;
    for (const event of r.events) {
        const { hash: h, ...body } = event;
        check(body.previous === prev && hash(body) === h, "Journal integrity failure");
        prev = h;
    }
}
function execute(a, state, reply, hasReply = false) {
    const output = run(a.program, state, hasReply ? { reply } : {});
    return output;
}
function request(r, ctx, output) {
    if (ctx.state.status === "done") {
        append(r, { kind: "done", result: output.done });
        ctx.pending = null;
        return;
    }
    const a = ctx.a,
        site = ctx.state.site;
    check(a.contracts[site], "Missing reply contract");
    const event = {
        kind: "request",
        id: `${r.invocation}:${r.events.length}`,
        artifact: a.id,
        site,
        request: output.effect,
        contract: a.contracts[site],
    };
    append(r, event);
    ctx.pending = event;
}
function checkpoint(r, ctx) {
    const body = {
        format: 1,
        cursor: r.events.length,
        journalHash: r.events.at(-1)?.hash ?? null,
        artifact: ctx.a.id,
        state: ctx.state,
        pending: ctx.pending,
    };
    r.checkpoint = { ...copy(body), checksum: hash(body) };
}
export function recover(r, registry) {
    verify(r);
    let ctx,
        cursor = 0;
    const c = r.checkpoint;
    if (c) {
        const { checksum, ...body } = c;
        check(c.format === 1, "Unsupported checkpoint format");
        check(hash(body) === checksum, "Checkpoint integrity failure");
        check(
            Number.isInteger(c.cursor) && c.cursor >= 1 && c.cursor <= r.events.length,
            "Invalid checkpoint cursor",
        );
        check(c.journalHash === r.events[c.cursor - 1].hash, "Checkpoint journal mismatch");
        ctx = { a: load(registry, c.artifact), state: copy(c.state), pending: copy(c.pending) };
        check(
            ctx.state.program === ctx.a.program.id && ctx.state.version === 1,
            "Checkpoint program mismatch",
        );
        cursor = c.cursor;
    } else {
        const a = load(registry, r.initialArtifact);
        ctx = { a, state: start(a.program), pending: null };
        ctx.output = execute(a, ctx.state);
    }
    for (const e of r.events.slice(cursor)) {
        if (e.kind === "request") {
            check(
                ctx.output &&
                    ctx.state.status === "waiting" &&
                    equal(ctx.output.effect, e.request) &&
                    ctx.state.site === e.site &&
                    ctx.a.id === e.artifact &&
                    equal(ctx.a.contracts[e.site], e.contract),
                "Replay request mismatch",
            );
            ctx.pending = copy(e);
            delete ctx.output;
        } else if (e.kind === "accepted") {
            check(
                ctx.pending?.id === e.id && valid(ctx.pending.contract, e.reply),
                "Invalid accepted reply",
            );
            ctx.pending = null;
            ctx.output = execute(ctx.a, ctx.state, e.reply, true);
        } else if (e.kind === "migrated") {
            check(
                ctx.a.id === e.from && ctx.pending?.id === e.pendingId,
                "Migration boundary mismatch",
            );
            ctx.a = load(registry, e.to);
            ctx.state = copy(e.state);
            check(ctx.state.program === ctx.a.program.id, "Migration program mismatch");
            delete ctx.output;
        } else if (e.kind === "done") {
            check(
                ctx.state.status === "done" && ctx.output && equal(ctx.output.done, e.result),
                "Replay completion mismatch",
            );
            delete ctx.output;
        } else {
            throw Error("Unknown journal event");
        }
    }
    return ctx;
}
export function create(a, invocation) {
    const r = { revision: 0, invocation, initialArtifact: a.id, events: [] };
    const ctx = { a, state: start(a.program), pending: null };
    request(r, ctx, execute(a, ctx.state));
    checkpoint(r, ctx);
    return r;
}
export function accept(record, registry, { revision, id, reply }) {
    verify(record);
    const prior = record.events.find((e) => e.kind === "accepted" && e.id === id);
    if (prior) {
        check(equal(prior.reply, reply), "Conflicting duplicate reply");
        const ctx = recover(record, registry);
        return ctx.output ? repair(record, registry) : copy(record);
    }
    check(record.revision === revision, "Revision conflict");
    const r = copy(record),
        ctx = recover(r, registry);
    check(ctx.pending?.id === id, "Stale effect identity");
    check(valid(ctx.pending.contract, reply), "Reply contract mismatch");
    append(r, { kind: "accepted", id, reply });
    ctx.pending = null;
    request(r, ctx, execute(ctx.a, ctx.state, reply, true));
    r.revision++;
    checkpoint(r, ctx);
    return r;
}
// Conservative structural rule: every function and instruction slot retains its role.
// Only literal values and variable references may differ; changed call/control layout is rejected.
function shape(p) {
    return p.functions.map((f) => ({
        params: f.params,
        code: f.code.map((i) => (["const", "get"].includes(i[0]) ? [i[0]] : i)),
    }));
}
export function compatibility(record, registry, target) {
    const ctx = recover(record, registry);
    if (ctx.a.id === target.id) {
        return { status: "direct" };
    }
    if (!ctx.pending) {
        return { status: "retain-original", reason: "Only waiting boundaries can migrate" };
    }
    if (!equal(ctx.pending.contract, target.contracts[ctx.pending.site] ?? null)) {
        return {
            status: "retain-original",
            reason: "Pending reply contract changed or resume point removed",
        };
    }
    if (!equal(shape(ctx.a.program), shape(target.program))) {
        return { status: "retain-original", reason: "Function or continuation layout changed" };
    }
    return {
        status: "explicit-migration",
        reason: "Compatible layout does not prove equivalent behavior",
    };
}
export function migrate(record, registry, target, plan) {
    check(record.revision === plan.revision, "Revision conflict");
    const report = compatibility(record, registry, target);
    check(report.status === "explicit-migration", report.reason ?? "Migration unnecessary");
    const r = copy(record),
        ctx = recover(r, registry);
    check(plan.from === ctx.a.id && plan.to === target.id, "Migration version mismatch");
    // Data-only migration plan: add a checked binding to an environment selected by active frame.
    for (const patch of plan.addBindings ?? []) {
        check(
            Number.isInteger(patch.frame) &&
                patch.frame >= 0 &&
                patch.frame < ctx.state.frames.length,
            "Invalid migration frame",
        );
        const env = ctx.state.heap[ctx.state.frames[patch.frame].env];
        check(!Object.hasOwn(env.bindings, patch.name), "Migration would overwrite binding");
        check(valid(patch.schema, patch.value), "Migration value violates schema");
        Object.defineProperty(env.bindings, patch.name, {
            value: copy(patch.value),
            enumerable: true,
        });
    }
    const from = ctx.a.id;
    ctx.state.program = target.program.id;
    // Reject newly introduced unresolved references, including code reachable through closures.
    const contexts = [];
    for (const f of ctx.state.frames) {
        contexts.push({ fn: f.fn, env: f.env });
    }
    function scan(v) {
        if (!v || typeof v !== "object") {
            return;
        }
        if (Number.isInteger(v.closure)) {
            contexts.push({ fn: v.closure, env: v.env });
        }
        for (const x of Object.values(v)) {
            scan(x);
        }
    }
    scan(ctx.state.heap);
    scan(ctx.state.frames.map((f) => f.stack));
    function reachable(env, key) {
        for (let e = env; e !== null; e = ctx.state.heap[e].parent) {
            if (Object.hasOwn(ctx.state.heap[e].bindings, key)) {
                return true;
            }
        }
        return ["+", "-", "=", "list", "string-append"].includes(key);
    }
    target.program.functions.forEach((f, fi) =>
        f.code.forEach((i, ip) => {
            const old = ctx.a.program.functions[fi].code[ip];
            if (i[0] === "get" && i[1] !== old[1]) {
                const sites = contexts.filter((c) => c.fn === fi);
                check(
                    sites.length > 0 &&
                        sites.every((c) => f.params.includes(i[1]) || reachable(c.env, i[1])),
                    "Unresolved lexical binding requires migration",
                );
            }
        }),
    );
    ctx.a = load(registry, target.id);
    append(r, {
        kind: "migrated",
        migration: hash(plan),
        from,
        to: target.id,
        pendingId: ctx.pending.id,
        state: copy(ctx.state),
    });
    r.revision++;
    checkpoint(r, ctx);
    return r;
}

export function repair(record, registry) {
    const r = copy(record),
        ctx = recover(r, registry);
    if (ctx.output) {
        request(r, ctx, ctx.output);
        r.revision++;
    }
    checkpoint(r, ctx);
    return r;
}
