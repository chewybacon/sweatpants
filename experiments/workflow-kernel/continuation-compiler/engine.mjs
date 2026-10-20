// Experimental Scheme subset. JSON is the checkpoint format; no host closures are saved.
import { createHash } from "node:crypto";
import { parse } from "../../../packages/flowmode-compiler/src/scheme-data/read.mjs";
const sym = (x) => ({ sym: x });
const name = (x) => {
  if (!x?.sym) {
    throw Error("Expected identifier");
  }
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
      if (i < xs.length - 1) {
        c.push(["pop"]);
      }
    });
  }
  function expr(x, c, tail = false) {
    if (!Array.isArray(x)) {
      c.push(x?.sym ? ["get", x.sym] : ["const", x]);
      return;
    }
    if (!x.length) {
      throw Error("Empty application");
    }
    const op = x[0]?.sym;
    if (op === "lambda") {
      c.push(["closure", fn(x[1].map(name), x.slice(2))]);
      return;
    }
    if (op === "let") {
      if (!Array.isArray(x[1])) {
        throw Error("Named let is not supported in this spike");
      }
      expr(
        [[sym("lambda"), x[1].map((b) => b[0]), ...x.slice(2)], ...x[1].map((b) => b[1])],
        c,
        tail,
      );
      return;
    }
    if (op === "begin") {
      sequence(x.slice(1), c, tail);
      return;
    }
    if (op === "if") {
      if (x.length !== 4) {
        throw Error("if expects three operands");
      }
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
      if (Array.isArray(x[1])) {
        expr([sym("lambda"), x[1].slice(1), ...x.slice(2)], c);
      } else {
        if (x.length !== 3) {
          throw Error("Invalid define");
        }
        expr(x[2], c);
      }
      c.push(["define", name(Array.isArray(x[1]) ? x[1][0] : x[1])]);
      return;
    }
    if (op === "yield-at") {
      if (x.length !== 3 || typeof x[1] !== "string") {
        throw Error("yield-at expects label and request");
      }
      expr(x[2], c);
      c.push(["yield", x[1]]);
      return;
    }
    if (op === "yield") {
      if (x.length !== 2) {
        throw Error("yield expects one request");
      }
      expr(x[1], c);
      c.push(["yield"]);
      return;
    }
    if (["set!", "call/cc", "quote", "define-syntax", "letrec"].includes(op)) {
      throw Error(`Unsupported form: ${op}`);
    }
    expr(x[0], c);
    for (const arg of x.slice(1)) {
      expr(arg, c);
    }
    c.push([tail ? "tailcall" : "call", x.length - 1]);
  }
  const entry = fn([], parse(source));
  const body = { version: 1, entry, functions };
  return { ...body, id: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}
const builtins = {
  "+": (...xs) => xs.reduce((a, b) => a + b, 0),
  "-": (a, b) => a - b,
  "=": (a, b) => a === b,
  list: (...xs) => xs,
  "string-append": (...xs) => xs.join(""),
};
export function start(program) {
  return {
    version: 1,
    program: program.id,
    heap: [{ parent: null, bindings: {} }],
    frames: [{ fn: program.entry, ip: 0, env: 0, stack: [] }],
    status: "running",
    maxFrames: 1,
  };
}
export function run(program, state, { reply, fuel = 100000 } = {}) {
  if (state.version !== 1 || state.program !== program.id) {
    throw Error("Checkpoint/program mismatch");
  }
  if (state.status === "done") {
    throw Error("Program already completed");
  }
  if (state.status === "waiting") {
    if (reply === undefined) {
      throw Error("A reply is required");
    }
    state.frames.at(-1).stack.push(reply);
    state.status = "running";
  }
  function lookup(env, key) {
    for (let e = env; e !== null; e = state.heap[e].parent) {
      if (Object.hasOwn(state.heap[e].bindings, key)) {
        return state.heap[e].bindings[key];
      }
    }
    if (Object.hasOwn(builtins, key)) {
      return { builtin: key };
    }
    throw Error(`Unbound name: ${key}`);
  }
  function finish(value) {
    state.frames.pop();
    if (state.frames.length) {
      state.frames.at(-1).stack.push(value);
    } else {
      state.status = "done";
      state.result = value;
    }
  }
  while (state.frames.length) {
    if (fuel-- <= 0) {
      throw Error("Instruction budget exhausted");
    }
    const f = state.frames.at(-1),
      s = f.stack,
      ins = program.functions[f.fn].code[f.ip++];
    if (!ins) {
      throw Error("Invalid instruction pointer");
    }
    const [op, arg] = ins;
    switch (op) {
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
        const v = s.pop();
        Object.defineProperty(state.heap[f.env].bindings, arg, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        s.push(null);
        break;
      }
      case "pop":
        s.pop();
        break;
      case "false":
        if (s.pop() === false) {
          f.ip = arg;
        }
        break;
      case "jump":
        f.ip = arg;
        break;
      case "yield":
        state.status = "waiting";
        state.site = arg ?? null;
        return { effect: s.pop(), state };
      case "return":
        finish(s.pop());
        break;
      case "call":
      case "tailcall": {
        const args = s.splice(s.length - arg, arg),
          callee = s.pop();
        if (callee?.builtin) {
          const value = builtins[callee.builtin](...args);
          if (op === "tailcall") {
            finish(value);
          } else {
            s.push(value);
          }
          break;
        }
        if (!Number.isInteger(callee?.closure)) {
          throw Error("Not callable");
        }
        const def = program.functions[callee.closure];
        if (args.length !== def.params.length) {
          throw Error("Arity mismatch");
        }
        const env = state.heap.length;
        state.heap.push({
          parent: callee.env,
          bindings: Object.fromEntries(def.params.map((p, i) => [p, args[i]])),
        });
        const next = { fn: callee.closure, ip: 0, env, stack: [] };
        if (op === "tailcall") {
          state.frames[state.frames.length - 1] = next;
        } else {
          state.frames.push(next);
        }
        state.maxFrames = Math.max(state.maxFrames, state.frames.length);
        break;
      }
      default:
        throw Error(`Unknown opcode ${op}`);
    }
  }
  return { done: state.result, state };
}
