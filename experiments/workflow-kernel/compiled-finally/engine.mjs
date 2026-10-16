// Experimental Scheme subset. JSON is the checkpoint format; no host closures are saved.
import { createHash } from "node:crypto";
import { parse } from "../scheme-data/read.mjs";
const sym = (x) => ({ sym: x });
const name = (x) => {
    if (!x?.sym) throw Error("Expected identifier");
    return x.sym;
};
export function compile(source) {
    const functions = [];
    function fn(params, body) {
        const id = functions.length,
            code = [];
        functions.push({ params, code });
        sequence(body, code, true);
        code.push(["return"]);
        return id;
    }
    function sequence(xs, c, tail) {
        if (!xs.length) {
            c.push(["const", null]);
            return;
        }
        xs.forEach((x, i) => {
            expr(x, c, tail && i === xs.length - 1);
            if (i < xs.length - 1) c.push(["pop"]);
        });
    }
    function expr(x, c, tail = false) {
        if (!Array.isArray(x)) {
            c.push(x?.sym ? ["get", x.sym] : ["const", x]);
            return;
        }
        if (!x.length) throw Error("Empty application");
        const op = x[0]?.sym;
        if (op === "lambda") {
            c.push(["closure", fn(x[1].map(name), x.slice(2))]);
            return;
        }
        if (op === "let") {
            if (!Array.isArray(x[1])) throw Error("Named let is not supported in this spike");
            expr(
                [[sym("lambda"), x[1].map((b) => b[0]), ...x.slice(2)], ...x[1].map((b) => b[1])],
                c,
                tail,
            );
            return;
        }
        if (op === "block") {
            c.push(["enter-block"]);
            sequence(x.slice(1), c, false);
            c.push(["leave-block"]);
            return;
        }
        if (op === "begin") {
            sequence(x.slice(1), c, tail);
            return;
        }
        if (op === "if") {
            if (x.length !== 4) throw Error("if expects three operands");
            expr(x[1], c);
            const branch = c.length;
            c.push(["false", 0]);
            expr(x[2], c, tail);
            const end = c.length;
            c.push(["jump", 0]);
            c[branch][1] = c.length;
            expr(x[3], c, tail);
            c[end][1] = c.length;
            return;
        }
        if (op === "define") {
            if (Array.isArray(x[1])) expr([sym("lambda"), x[1].slice(1), ...x.slice(2)], c);
            else {
                if (x.length !== 3) throw Error("Invalid define");
                expr(x[2], c);
            }
            c.push(["define", name(Array.isArray(x[1]) ? x[1][0] : x[1])]);
            return;
        }
        if (op === "set!") {
            if (x.length !== 3) throw Error("set! expects name and value");
            expr(x[2], c);
            c.push(["set", name(x[1])]);
            return;
        }
        if (op === "while") {
            const enter = c.length;
            c.push(["loop", null]);
            const test = c.length;
            expr(x[1], c);
            const exit = c.length;
            c.push(["false", 0]);
            expr(x[2], c);
            c.push(["pop"], ["jump", test]);
            c[exit][1] = c.length;
            c.push(["end-loop"]);
            c[enter][1] = { test, end: c.length };
            return;
        }
        if (op === "break" || op === "continue") {
            c.push([op]);
            return;
        }
        if (op === "scope") {
            if (x.length !== 3 || typeof x[1] !== "string")
                throw Error("scope expects a source site and closure");
            expr(x[2], c);
            c.push(["scope", x[1]]);
            return;
        }
        if (op === "ensure") {
            if (x.length !== 2) throw Error("ensure expects a closure");
            expr(x[1], c);
            c.push(["ensure"]);
            return;
        }
        if (op === "workflow-return" || op === "workflow-throw") {
            if (x.length !== 2) throw Error("Expected completion value");
            expr(x[1], c);
            c.push([op === "workflow-return" ? "return" : "throw"]);
            return;
        }
        if (op === "try-finally") {
            if (x.length !== 3) throw Error("Expected body and cleanup");
            const enter = c.length;
            c.push(["protect", null]);
            expr(x[1], c, false);
            c.push(["leave"]);
            const cleanup = c.length;
            expr(x[2], c, false);
            c.push(["end-finally"]);
            c[enter][1] = { cleanup, end: c.length };
            return;
        }
        if (op === "yield-at") {
            if (x.length !== 3 || typeof x[1] !== "string")
                throw Error("yield-at expects label and request");
            expr(x[2], c);
            c.push(["yield", x[1]]);
            return;
        }
        if (op === "yield") {
            if (x.length !== 2) throw Error("yield expects one request");
            expr(x[1], c);
            c.push(["yield"]);
            return;
        }
        if (["call/cc", "quote", "define-syntax", "letrec"].includes(op))
            throw Error(`Unsupported form: ${op}`);
        expr(x[0], c);
        for (const arg of x.slice(1)) expr(arg, c);
        c.push([tail ? "tailcall" : "call", x.length - 1]);
    }
    const entry = fn([], parse(source));
    const body = { version: 2, runtime: "explicit-tool-contracts-v4", entry, functions };
    return { ...body, id: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}
const builtins = {
    "js-add": (a, b) => a + b,
    truthy: (value) => !!value,
    "<": (a, b) => a < b,
    ">": (a, b) => a > b,
    "<=": (a, b) => a <= b,
    ">=": (a, b) => a >= b,
    not: (value) => !value,
    "+": (...xs) => xs.reduce((a, b) => a + b, 0),
    "-": (a, b) => a - b,
    "=": (a, b) => a === b,
    "json-field": (object, key) => {
        if (
            object === null ||
            typeof object !== "object" ||
            Array.isArray(object) ||
            !Object.hasOwn(object, key)
        )
            throw Error("Missing JSON object field: " + key);
        return object[key];
    },
    object: (...pairs) => Object.fromEntries(pairs),
    list: (...xs) => xs,
    "string-append": (...xs) => xs.join(""),
};

export function start(program, input = null) {
    return {
        version: 2,
        program: program.id,
        heap: [{ parent: null, bindings: { "%input": input } }],
        scopes: [{ id: 0, parent: null, phase: "body", cleanups: [] }],
        nextScope: 1,
        frames: [{ fn: program.entry, ip: 0, env: 0, stack: [], handlers: [], scopeBoundary: 0 }],
        status: "running",
        maxFrames: 1,
    };
}
export function run(program, state, options = {}) {
    if (
        state.version !== 2 ||
        state.program !== program.id ||
        program.runtime !== "explicit-tool-contracts-v4"
    )
        throw Error("Checkpoint/program mismatch");
    if (state.status === "done") throw Error("Program already completed");
    let fuel = options.fuel ?? 100000;
    function lookup(env, key) {
        for (let e = env; e !== null; e = state.heap[e].parent) {
            if (Object.hasOwn(state.heap[e].bindings, key)) return state.heap[e].bindings[key];
        }
        if (Object.hasOwn(builtins, key)) return { builtin: key };
        throw Error(`Unbound name: ${key}`);
    }
    function finish(outcome) {
        state.status = "done";
        state.outcome = outcome;
        delete state.pendingEffect;
        delete state.site;
    }
    function drainScope(scope, outcome) {
        if (scope.phase !== "cleanup") {
            scope.outcome = outcome;
            scope.phase = "cleanup";
        } else if (outcome.kind === "thrown") {
            (scope.errors ??= []).push(outcome.value);
            // Match native Effection: drain all cleanups; the last failure wins.
            scope.outcome = outcome;
        }
        if (scope.id === 0) state.scopePhase = "cleanup";
        const cleanup = scope.cleanups.pop();
        if (cleanup) {
            const env = state.heap.length;
            state.heap.push({ parent: cleanup.env, bindings: {} });
            state.frames.push({
                fn: cleanup.closure,
                ip: 0,
                env,
                stack: [],
                handlers: [],
                cleanupScope: scope.id,
            });
            state.status = "running";
            return;
        }
        if (state.scopes.pop() !== scope) throw Error("Scope ownership mismatch");
        let pending = scope.outcome;
        if (state.cancellationRequested && !cleaning() && pending.kind === "returned")
            pending = { kind: "cancelled" };
        if (!state.frames.length) {
            finish(pending);
            return;
        }
        if (pending.kind === "returned") {
            state.frames.at(-1).stack.push(pending.value);
            state.status = "running";
        } else unwind(pending);
    }
    function startCleanup(frame, handler, outcome) {
        handler.phase = "cleanup";
        handler.pending = outcome;
        frame.stack.length = handler.depth;
        frame.ip = handler.cleanup;
        state.status = "running";
    }
    function unwind(outcome) {
        while (state.frames.length) {
            const f = state.frames.at(-1);
            while (f.handlers.length) {
                const h = f.handlers.at(-1);
                if (h.kind === "lexical") {
                    f.env = h.env;
                    f.stack.length = h.depth;
                    f.handlers.pop();
                    continue;
                }
                if (h.kind === "loop") {
                    if (outcome.kind === "break" || outcome.kind === "continue") {
                        f.stack.length = h.depth;
                        f.ip = outcome.kind === "break" ? h.end : h.test;
                        if (outcome.kind === "break") {
                            f.handlers.pop();
                            f.stack.push(null);
                        }
                        state.status = "running";
                        return;
                    }
                    f.handlers.pop();
                    continue;
                }
                if (h.phase === "body") {
                    startCleanup(f, h, outcome);
                    return;
                }
                // An error raised during cleanup replaces its pending completion.
                f.handlers.pop();
                f.stack.length = h.depth;
            }
            state.frames.pop();
            const boundary = f.cleanupScope ?? f.scopeBoundary;
            if (boundary !== undefined) {
                const scope = state.scopes.at(-1);
                if (scope?.id !== boundary) throw Error("Scope/frame mismatch");
                drainScope(scope, outcome);
                return;
            }
            if (outcome.kind === "returned") {
                if (state.frames.length) {
                    state.frames.at(-1).stack.push(outcome.value);
                    state.status = "running";
                } else finish(outcome);
                return;
            }
        }
        finish(outcome);
    }
    const cleaning = () =>
        state.scopes.some((scope) => scope.phase === "cleanup") ||
        state.frames.some((f) => f.handlers.some((h) => h.phase === "cleanup"));
    if (options.cancel) {
        state.cancellationRequested = true;
        if (cleaning()) {
            if (!Object.hasOwn(options, "reply") && !Object.hasOwn(options, "error"))
                return { waiting: state.status === "waiting", effect: state.pendingEffect, state };
        } else {
            unwind({ kind: "cancelled" });
        }
    }
    if (state.status === "waiting") {
        if (Object.hasOwn(options, "error")) {
            state.status = "running";
            unwind({ kind: "thrown", value: options.error });
        } else if (Object.hasOwn(options, "reply")) {
            state.frames.at(-1).stack.push(options.reply);
            state.status = "running";
        } else throw Error("Reply required");
    }
    while (state.frames.length && state.status !== "done") {
        if (fuel-- <= 0) throw Error("Instruction budget exhausted");
        const f = state.frames.at(-1),
            s = f.stack,
            ins = program.functions[f.fn].code[f.ip++];
        if (!ins) throw Error("Invalid instruction pointer");
        const [op, arg] = ins;
        switch (op) {
            case "scope": {
                const body = s.pop();
                if (
                    !Number.isInteger(body?.closure) ||
                    program.functions[body.closure].params.length
                )
                    throw Error("Expected zero-argument scope body");
                const id = state.nextScope++,
                    parent = state.scopes.at(-1).id;
                state.scopes.push({ id, parent, site: arg, phase: "body", cleanups: [] });
                const env = state.heap.length;
                state.heap.push({ parent: body.env, bindings: {} });
                state.frames.push({
                    fn: body.closure,
                    ip: 0,
                    env,
                    stack: [],
                    handlers: [],
                    scopeBoundary: id,
                });
                state.maxFrames = Math.max(state.maxFrames, state.frames.length);
                break;
            }
            case "ensure": {
                const cleanup = s.pop();
                if (
                    !Number.isInteger(cleanup?.closure) ||
                    program.functions[cleanup.closure].params.length
                )
                    throw Error("Expected zero-argument cleanup");
                state.scopes.at(-1).cleanups.push(cleanup);
                s.push(null);
                break;
            }
            case "const":
                s.push(arg);
                break;
            case "get":
                s.push(lookup(f.env, arg));
                break;
            case "closure":
                s.push({ closure: arg, env: f.env });
                break;
            case "define": {
                const value = s.pop();
                Object.defineProperty(state.heap[f.env].bindings, arg, {
                    value,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
                s.push(null);
                break;
            }
            case "set": {
                const value = s.pop();
                let env = f.env;
                while (env !== null && !Object.hasOwn(state.heap[env].bindings, arg))
                    env = state.heap[env].parent;
                if (env === null) throw Error("Unbound assignment: " + arg);
                state.heap[env].bindings[arg] = value;
                s.push(value);
                break;
            }
            case "enter-block": {
                f.handlers.push({ kind: "lexical", env: f.env, depth: s.length });
                const env = state.heap.length;
                state.heap.push({ parent: f.env, bindings: {} });
                f.env = env;
                break;
            }
            case "leave-block": {
                const value = s.pop(),
                    h = f.handlers.pop();
                if (h?.kind !== "lexical") throw Error("Lexical handler mismatch");
                f.env = h.env;
                s.length = h.depth;
                s.push(value);
                break;
            }
            case "loop":
                f.handlers.push({ ...arg, kind: "loop", phase: "body", depth: s.length });
                break;
            case "end-loop": {
                const h = f.handlers.pop();
                if (h?.kind !== "loop") throw Error("Loop handler mismatch");
                s.length = h.depth;
                s.push(null);
                break;
            }
            case "break":
            case "continue":
                unwind({ kind: op });
                break;
            case "pop":
                s.pop();
                break;
            case "false":
                if (s.pop() === false) f.ip = arg;
                break;
            case "jump":
                f.ip = arg;
                break;
            case "protect":
                f.handlers.push({ ...arg, phase: "body", depth: s.length });
                break;
            case "leave":
                startCleanup(f, f.handlers.at(-1), { kind: "normal", value: s.pop() });
                break;
            case "end-finally": {
                const h = f.handlers.pop();
                s.length = h.depth;
                let outcome = h.pending;
                if (state.cancellationRequested && !cleaning() && outcome.kind !== "thrown")
                    outcome = { kind: "cancelled" };
                if (outcome.kind === "normal") {
                    s.push(outcome.value);
                    f.ip = h.end;
                } else unwind(outcome);
                break;
            }
            case "yield":
                state.status = "waiting";
                state.site = arg ?? null;
                state.pendingEffect = s.pop();
                return { effect: state.pendingEffect, state };
            case "return":
                unwind({ kind: "returned", value: s.pop() });
                break;
            case "throw":
                unwind({ kind: "thrown", value: s.pop() });
                break;
            case "call":
            case "tailcall": {
                const args = s.splice(s.length - arg, arg),
                    callee = s.pop();
                if (callee?.builtin) {
                    const value = builtins[callee.builtin](...args);
                    if (op === "tailcall") unwind({ kind: "returned", value });
                    else s.push(value);
                    break;
                }
                if (!Number.isInteger(callee?.closure)) throw Error("Not callable");
                const def = program.functions[callee.closure];
                if (args.length !== def.params.length) throw Error("Arity mismatch");
                const env = state.heap.length;
                state.heap.push({
                    parent: callee.env,
                    bindings: Object.fromEntries(def.params.map((p, i) => [p, args[i]])),
                });
                const frame = { fn: callee.closure, ip: 0, env, stack: [], handlers: [] };
                // A protected frame must survive a tail call to run its finally.
                if (op === "tailcall" && !f.handlers.length) {
                    if (f.scopeBoundary !== undefined) frame.scopeBoundary = f.scopeBoundary;
                    if (f.cleanupScope !== undefined) frame.cleanupScope = f.cleanupScope;
                    state.frames[state.frames.length - 1] = frame;
                } else state.frames.push(frame);
                state.maxFrames = Math.max(state.maxFrames, state.frames.length);
                break;
            }
            default:
                throw Error("Unknown opcode " + op);
        }
    }
    return { outcome: state.outcome, state };
}
