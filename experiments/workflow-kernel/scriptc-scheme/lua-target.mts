import { verifyWorkflowModule } from "../../../packages/v2/codemode-compiler/src/index.ts";
import { createHash } from "node:crypto";
import type { CapabilityRequest } from "../../../packages/v2/core/src/index.ts";
import type {
  WorkflowModule,
  WorkflowLinker,
  LinkedWorkflow,
} from "../../../packages/v2/codemode-compiler/src/index.ts";
import {
  parse,
  symbolName,
  type SchemeDatum,
} from "../../../packages/v2/codemode-runtime-scheme/src/scheme-data/read.ts";
import { bindEffectBoundary } from "./boundary.mts";

// Byte escapes preserve Unicode and control characters in Piccolo's Lua reader.
export function luaString(value: string): string {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error("Lua strings require well-formed Unicode");
  }
  return (
    '"' +
    [...new TextEncoder().encode(value)]
      .map((byte) => `\\${String(byte).padStart(3, "0")}`)
      .join("") +
    '"'
  );
}

/** Trusted shared IR -> Lua function module. This bounded target consumes no ScriptC nodes. */
export function emitReviewLua(module: WorkflowModule): string {
  verifyWorkflowModule(module);
  if (module.format !== "workflow-scheme/1" || module.entry.parameters !== "input") {
    throw new Error("Unsupported Lua workflow profile");
  }
  const definitions = parse(module.sexpressions);
  if (definitions.length !== 1) {
    throw new Error("Lua experiment requires one workflow definition");
  }
  let serial = 0;
  const fresh = () => `__v${serial++}`;
  const names = new Map<string, string>();
  function fail(): never {
    throw new Error("Unsupported Lua workflow IR");
  }
  function sym(value: SchemeDatum | undefined): string {
    return symbolName(value) ?? fail();
  }
  function list(value: SchemeDatum | undefined): SchemeDatum[] {
    return Array.isArray(value) ? value : fail();
  }
  for (const definition of definitions) {
    const form = list(definition);
    if (sym(form[0]) !== "define" || form.length < 3) {
      fail();
    }
    const signature = list(form[1]);
    const name = sym(signature[0]);
    if (names.has(name)) {
      fail();
    }
    names.set(name, fresh());
  }
  if (!names.has(module.entry.name)) {
    fail();
  }
  function lookup(value: SchemeDatum | undefined, env: Map<string, string>): string {
    return env.get(sym(value)) ?? fail();
  }
  function expr(value: SchemeDatum | undefined, env: Map<string, string>): string {
    if (typeof value === "string") {
      return luaString(value);
    }
    // The admitted frontend currently has string-only values. Do not silently
    // translate Scheme numeric/boolean semantics through Lua's truthiness/coercions.
    if (!Array.isArray(value)) {
      return lookup(value, env);
    }
    const head = symbolName(value[0]);
    if (head === "lambda") {
      const nested = new Map(env);
      const parameters = list(value[1]);
      if (new Set(parameters.map(sym)).size !== parameters.length) {
        fail();
      }
      const params = parameters.map((p) => {
        const id = fresh();
        nested.set(sym(p), id);
        return id;
      });
      return `(function(${params.join(",")})\n${block(value.slice(2), nested, true)}\nend)`;
    }
    if (head === "json-field") {
      if (value.length !== 3 || typeof value[2] !== "string") {
        fail();
      }
      return orderedCall("__field", value.slice(1), env);
    }
    if (head === "not") {
      if (value.length !== 2) {
        fail();
      }
      // Scheme considers only false false; Lua also considers nil false.
      return `(${expr(value[1], env)} == false)`;
    }
    if (head === "js-add") {
      if (value.length !== 3) {
        fail();
      }
      return orderedCall("__add", value.slice(1), env);
    }
    if (head === "list") {
      const vars = value.slice(1).map(() => fresh());
      return `(function() ${vars.map((v, i) => `local ${v} = ${expr(value[i + 1], env)}`).join("\n")}\nreturn __array({${vars.join(",")}}) end)()`;
    }
    if (head === "yield-at") {
      if (
        value.length !== 3 ||
        typeof value[1] !== "string" ||
        !Object.hasOwn(module.effects, value[1])
      ) {
        fail();
      }
      return `__effect(${luaString(value[1])}, ${expr(value[2], env)})`;
    }
    // Only lexically known functions and lambda applications are callable.
    const callee = Array.isArray(value[0]) ? expr(value[0], env) : lookup(value[0], env);
    return orderedCall(callee, value.slice(1), env);
  }
  function orderedCall(callee: string, args: SchemeDatum[], env: Map<string, string>): string {
    const fn = fresh();
    const vars = args.map(() => fresh());
    return `(function() local ${fn} = ${callee}\n${vars.map((v, i) => `local ${v} = ${expr(args[i], env)}`).join("\n")}\nreturn ${fn}(${vars.join(",")}) end)()`;
  }
  function block(
    forms: SchemeDatum[],
    outer: Map<string, string>,
    implicit = false,
    cleanupRegion = false,
  ): string {
    if (implicit) {
      const tail = forms.at(-1);
      if (
        tail === undefined ||
        (Array.isArray(tail) && ["define", "set!", "if"].includes(symbolName(tail[0]) ?? ""))
      ) {
        fail();
      }
    }
    const env = new Map(outer);
    const lines: string[] = [];
    for (const [index, form] of forms.entries()) {
      const head = Array.isArray(form) ? symbolName(form[0]) : undefined;
      if (head === "define") {
        const parts = list(form);
        if (parts.length !== 3 || env.has(sym(parts[1]))) {
          fail();
        }
        const value = expr(parts[2], env);
        const id = fresh();
        env.set(sym(parts[1]), id);
        lines.push(`local ${id} = ${value}`);
      } else if (head === "set!") {
        const parts = list(form);
        if (parts.length !== 3) {
          fail();
        }
        lines.push(`${lookup(parts[1], env)} = ${expr(parts[2], env)}`);
      } else if (head === "workflow-return" || head === "workflow-throw") {
        if (implicit || (cleanupRegion && head === "workflow-return")) {
          fail();
        }
        const parts = list(form);
        if (parts.length !== 2) {
          fail();
        }
        lines.push(
          head === "workflow-return"
            ? `do return { returned = true, value = ${expr(parts[1], env)} } end`
            : `__raise(${expr(parts[1], env)})`,
        );
      } else if (head === "if") {
        const parts = list(form);
        if (parts.length !== 4) {
          fail();
        }
        const yes = list(parts[2]),
          no = list(parts[3]);
        if (sym(yes[0]) !== "block" || sym(no[0]) !== "block") {
          fail();
        }
        lines.push(
          `if ${expr(parts[1], env)} ~= false then\n${block(yes.slice(1), new Map(env), false, cleanupRegion)}\nelse\n${block(no.slice(1), new Map(env), false, cleanupRegion)}\nend`,
        );
      } else if (head === "try-finally") {
        if (implicit) {
          fail();
        }
        const parts = list(form);
        if (parts.length !== 3) {
          fail();
        }
        const body = list(parts[1]),
          cleanup = list(parts[2]);
        if (sym(body[0]) !== "block" || sym(cleanup[0]) !== "block") {
          fail();
        }
        const completion = fresh();
        lines.push(
          `local ${completion} = __scope(function()\n${block(body.slice(1), env, false, cleanupRegion)}\nreturn { returned = false }\nend, function()\n${block(cleanup.slice(1), env, false, true)}\nend)\nif ${completion}.returned then return ${completion} end`,
        );
      } else {
        const value = expr(form, env);
        lines.push(
          implicit && index === forms.length - 1
            ? `return ${value}`
            : `local ${fresh()} = ${value}`,
        );
      }
    }
    return lines.join("\n");
  }
  const functions = definitions.map((definition) => {
    const form = list(definition),
      signature = list(form[1]);
    const env = new Map(names);
    const parameters = signature.slice(1);
    if (new Set(parameters.map(sym)).size !== parameters.length) {
      fail();
    }
    const params = parameters.map((p) => {
      const id = fresh();
      env.set(sym(p), id);
      return id;
    });
    if (sym(signature[0]) === module.entry.name && params.length !== 1) {
      fail();
    }
    return `${names.get(sym(signature[0]))} = function(${params.join(",")})\nlocal __completion = (function()\n${block(form.slice(2), env)}\nend)()\nif __completion == nil then __raise("Compiled workflow fell through without returning") end\nreturn __completion.value\nend`;
  });
  return `local __effect, __scope, __raise, __type, __array = workflow.effect, workflow.scope, error, type, workflow.array
local function __field(object,key)
  if __type(object) ~= "table" then __raise("Expected JSON object") end
  local value = object[key]
  if value == nil then __raise("Missing JSON field") end
  return value
end
local function __add(a,b)
  if __type(a) ~= "string" or __type(b) ~= "string" then __raise("Expected string operands") end
  return a .. b
end
local ${[...names.values()].join(",")}
${functions.join("\n")}
return ${names.get(module.entry.name)}`;
}

/** Tiny Lua caller grammar; re-emission prevents escaping the host-owned closure.
 * local bindings, if/else, returns, strings, equality, concatenation and public calls.
 * No raw effects, global lookup, assignment, functions, loops or private identifiers. */
export function admitLuaReviewCaller(source: string, publicName: string): string {
  if (source.length > 12000) {
    throw new Error("Lua caller too large");
  }
  const tokens: string[] = [];
  const lexer =
    /\s+|--[^\r\n]*|"(?:[^"\\\r\n]|\\["\\nrt])*"|[A-Za-z_][A-Za-z0-9_]*|==|\.\.|[()=]/gy;
  let at = 0;
  while (at < source.length) {
    lexer.lastIndex = at;
    const match = lexer.exec(source);
    if (!match) {
      throw new Error("Unsupported Lua caller token");
    }
    at = lexer.lastIndex;
    if (/^--\[=*\[/.test(match[0])) {
      throw new Error("Lua long comments are not supported");
    }
    if (!/^\s|^--/.test(match[0])) {
      tokens.push(match[0]);
    }
  }
  let index = 0,
    id = 0;
  const peek = () => tokens[index];
  function take(expected?: string): string {
    const value = tokens[index++];
    if (!value || (expected && value !== expected)) {
      throw new Error("Unsupported Lua caller syntax");
    }
    return value;
  }
  function atom(env: Map<string, string>): string {
    const token = take();
    let value: string;
    if (token.startsWith('"')) {
      value = luaString(JSON.parse(token));
    } else if (token === publicName) {
      take("(");
      const arg = expression(env);
      take(")");
      value = `${publicName}(${arg})`;
    } else {
      value =
        env.get(token) ??
        (() => {
          throw new Error("Unknown Lua caller binding");
        })();
    }
    return value;
  }
  function concatenate(env: Map<string, string>): string {
    const value = atom(env);
    if (peek() !== "..") {
      return value;
    }
    take("..");
    return `(${value} .. ${concatenate(env)})`;
  }
  function expression(env: Map<string, string>): string {
    const value = concatenate(env);
    if (peek() !== "==") {
      return value;
    }
    take("==");
    return `(${value} == ${concatenate(env)})`;
  }
  function statements(parent: Map<string, string>): string {
    const env = new Map(parent),
      result: string[] = [];
    while (peek() && peek() !== "else" && peek() !== "end") {
      const kind = take();
      if (kind === "local") {
        const name = take();
        if (
          !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) ||
          env.has(name) ||
          name === publicName ||
          [
            "and",
            "break",
            "do",
            "else",
            "elseif",
            "end",
            "false",
            "for",
            "function",
            "goto",
            "if",
            "in",
            "local",
            "nil",
            "not",
            "or",
            "repeat",
            "return",
            "then",
            "true",
            "until",
            "while",
          ].includes(name)
        ) {
          throw new Error("Invalid Lua caller binding");
        }
        take("=");
        const value = expression(env);
        const emitted = `__caller${id++}`;
        env.set(name, emitted);
        result.push(`local ${emitted} = ${value}`);
      } else if (kind === "return") {
        result.push(`do return ${expression(env)} end`);
      } else if (kind === "if") {
        const condition = expression(env);
        take("then");
        const yes = statements(env);
        take("else");
        const no = statements(env);
        take("end");
        result.push(`if ${condition} then\n${yes}\nelse\n${no}\nend`);
      } else {
        throw new Error("Unsupported Lua caller statement");
      }
    }
    return result.join("\n");
  }
  const emitted = statements(new Map([["input", "input"]]));
  if (index !== tokens.length || !emitted) {
    throw new Error("Unsupported Lua caller syntax");
  }
  return emitted;
}

export function linkLuaReview(options: {
  module: WorkflowModule;
  caller: string;
  identity: string;
}) {
  const { module, identity } = options;
  const name = "review_draft";
  const implementation = emitReviewLua(module);
  const caller = admitLuaReviewCaller(options.caller, name);
  const metadata = createHash("sha256").update(JSON.stringify(module.effects)).digest("hex");
  const source = `local __metadata = ${luaString(metadata)}\nlocal ${name} = (function()\n${implementation}\nend)()\nreturn (function(input)\n${caller}\nend)(...)`;
  const program =
    "linked-lua-review:" +
    createHash("sha256").update(JSON.stringify({ source, identity })).digest("hex");
  return {
    source,
    program,
    identity,
    language: "lua" as const,
    name,
    entry: module.entry.name,
    effects: structuredClone(module.effects),
  };
}
export function bindLuaReviewBoundary(
  module: WorkflowModule,
  allowed: readonly string[],
): (boundary: unknown) => CapabilityRequest {
  const decode = bindEffectBoundary(module, allowed);
  return (boundary: unknown) => {
    if (
      !boundary ||
      typeof boundary !== "object" ||
      !("site" in boundary) ||
      typeof boundary.site !== "string" ||
      !("request" in boundary)
    ) {
      throw new Error("Malformed Lua workflow exchange");
    }
    return decode({ site: boundary.site, value: boundary.request });
  };
}

/** One compiled entry, using the shared linker contract and bounded Lua caller grammar. */
export const luaWorkflowLinker: WorkflowLinker<LinkedWorkflow> = {
  language: "lua",
  link({ module, caller, name, identity }) {
    if (caller.language !== "lua" || name !== "review_draft") {
      throw new Error("Unsupported Lua link binding");
    }
    return linkLuaReview({ module, caller: caller.text, identity });
  },
};
