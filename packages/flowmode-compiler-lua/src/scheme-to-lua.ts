import {
  parse,
  symbolName,
  type SchemeDatum,
} from "@sweatpants/flowmode-compiler/scheme-data/read";

// Decimal escapes encode UTF-8 independently of the source file's encoding.
function quote(value: string): string {
  return (
    '"' +
    [...new TextEncoder().encode(value)]
      .map((byte) =>
        byte >= 32 && byte < 127 && byte !== 34 && byte !== 92
          ? String.fromCharCode(byte)
          : `\\${String(byte).padStart(3, "0")}`,
      )
      .join("") +
    '"'
  );
}

/** Trusted compiler output only: this is a bounded dialect translator, not a Scheme evaluator. */
export function transpileWorkflowScheme(source: string, entry: string): string {
  const forms = parse(source);
  const is = (form: SchemeDatum | undefined, head: string): form is SchemeDatum[] =>
    Array.isArray(form) && symbolName(form[0]) === head;
  const fail = (form: SchemeDatum | undefined): never => {
    throw Error(`Unsupported workflow Scheme form: ${JSON.stringify(form)}`);
  };
  let nextBinding = 0;
  function bind(symbol: SchemeDatum, env: Map<string, string>): string {
    const symbolId = symbolName(symbol);
    if (!symbolId) {
      return fail(symbol);
    }
    const name = `v_${nextBinding++}`;
    env.set(symbolId, name);
    return name;
  }
  function expr(form: SchemeDatum, env: Map<string, string>): string {
    if (typeof form === "string") {
      return quote(form);
    }
    if (typeof form === "boolean") {
      return String(form);
    }
    if (typeof form === "number" && Number.isFinite(form)) {
      return String(form);
    }
    const symbolId = symbolName(form);
    if (symbolId && env.has(symbolId)) {
      return env.get(symbolId)!;
    }
    if (!Array.isArray(form)) {
      return fail(form);
    }
    const [head, ...args] = form;
    switch (symbolName(head)) {
      case "quote":
        if (args.length === 1 && symbolName(args[0]) === "json-null") {
          return "workflow.null";
        }
        break;
      case "json-field":
        if (args.length === 2 && typeof args[1] === "string") {
          return `${expr(args[0], env)}[${quote(args[1])}]`;
        }
        break;
      case "truthy":
      case "not":
        if (args.length === 1) {
          return symbolName(head) === "truthy"
            ? `truthy(${expr(args[0], env)})`
            : `(not ${expr(args[0], env)})`;
        }
        break;
      case "=":
        if (args.length === 2) {
          return `equal(${expr(args[0], env)}, ${expr(args[1], env)})`;
        }
        break;
      case "lambda": {
        if (!Array.isArray(args[0])) {
          return fail(form);
        }
        const local = new Map(env);
        const params = args[0].map((parameter) => bind(parameter, local));
        return `(function(${params.join(", ")})\n${body(args.slice(1), local)}\nend)`;
      }
      case "js-add":
        if (args.length === 2) {
          return `add(${expr(args[0], env)}, ${expr(args[1], env)})`;
        }
        break;
      case "-":
      case "<":
      case ">":
      case "<=":
      case ">=":
        if (args.length === 2) {
          return `(${expr(args[0], env)} ${symbolName(head)} ${expr(args[1], env)})`;
        }
        break;
      case "yield-at": {
        const [site, request] = args;
        if (
          args.length !== 2 ||
          typeof site !== "string" ||
          !is(request, "list") ||
          request.length !== 4 ||
          request[1] !== "elicit" ||
          typeof request[2] !== "string"
        ) {
          break;
        }
        return `workflow.effect(${quote(site)}, {binding = ${quote(JSON.stringify(["elicit", request[2]]))}, input = {message = ${expr(request[3], env)}}})`;
      }
    }
    if (symbolName(head) && env.has(symbolName(head)!)) {
      return `${expr(head, env)}(${args.map((arg) => expr(arg, env)).join(", ")})`;
    }
    return fail(form);
  }
  function body(
    statements: SchemeDatum[],
    inherited: Map<string, string>,
    { cleanup = false, root = false } = {},
  ): string {
    const env = new Map(inherited);
    const output = [];
    for (const [index, form] of statements.entries()) {
      if (is(form, "define") && form.length === 3 && symbolName(form[1])) {
        const value = expr(form[2], env);
        const name = bind(form[1], env);
        output.push(`local ${name} = ${value}`);
      } else if (
        is(form, "if") &&
        form.length === 4 &&
        is(form[2], "block") &&
        is(form[3], "block")
      ) {
        output.push(
          `if ${expr(form[1], env)} then`,
          body(form[2].slice(1), env, { cleanup }),
          "else",
          body(form[3].slice(1), env, { cleanup }),
          "end",
        );
      } else if (is(form, "workflow-return") && form.length === 2 && !cleanup) {
        output.push(`do return ${expr(form[1], env)} end`);
      } else if (is(form, "workflow-throw") && form.length === 2) {
        output.push(`error(${expr(form[1], env)})`);
      } else if (is(form, "ensure") && form.length === 2 && root && !cleanup) {
        const closure = form[1];
        if (!is(closure, "lambda") || !Array.isArray(closure[1]) || closure[1].length) {
          return fail(form);
        }
        // Registration closes over lexical bindings. Both closures share their Lua upvalues;
        // the existing managed scope preserves pending return/throw/cancel during cleanup.
        const release = body(closure.slice(2), env, { cleanup: true });
        const continuation = body(statements.slice(index + 1), env, { root: true });
        output.push(
          `return workflow.scope(function()\n${continuation}\nend, function()\n${release}\nend)`,
        );
        return output.join("\n");
      } else if (is(form, "set!") && form.length === 3 && env.has(symbolName(form[1])!)) {
        output.push(`${expr(form[1], env)} = ${expr(form[2], env)}`);
      } else if (
        is(form, "yield-at") ||
        (Array.isArray(form) && symbolName(form[0]) && env.has(symbolName(form[0])!))
      ) {
        output.push(expr(form, env));
      } else {
        return fail(form);
      }
    }
    if (root && !cleanup) {
      output.push('error("Compiled workflow fell through without a JSON return")');
    }
    return output.join("\n");
  }
  const env = new Map<string, string>();
  for (const form of forms) {
    if (
      !is(form, "define") ||
      !Array.isArray(form[1]) ||
      !symbolName(form[1][0]) ||
      env.has(symbolName(form[1][0])!)
    ) {
      return fail(form);
    }
    bind(form[1][0], env);
  }
  if (!env.has(entry)) {
    throw Error("Unknown workflow entry");
  }
  const declarations = [`local ${[...env.values()].join(", ")}`];
  for (const form of forms) {
    if (!Array.isArray(form) || !Array.isArray(form[1])) {
      return fail(form);
    }
    const [, signature, ...statements] = form;
    if (!Array.isArray(signature)) {
      return fail(form);
    }
    const local = new Map(env);
    const params = signature.slice(1).map((parameter) => bind(parameter, local));
    if (
      symbolName(signature[0]) === entry &&
      (signature.length !== 3 ||
        symbolName(signature[1]) !== "ctx" ||
        symbolName(signature[2]) !== "input")
    ) {
      return fail(signature);
    }
    declarations.push(
      `${env.get(symbolName(signature[0])!)} = function(${params.join(", ")})\n${body(statements, local, { root: symbolName(signature[0]) === entry })}\nend`,
    );
  }
  const code = declarations.join("\n");
  return `local function truthy(value)
return value ~= nil and value ~= false and value ~= 0 and value ~= "" and not workflow.is_null(value)
end
local function equal(left, right)
if workflow.is_null(left) then return workflow.is_null(right) end
return left == right
end
local function add(left, right)
if type(left) == "number" and type(right) == "number" then return left + right end
return left .. right
end
${code}
return function(input) return ${env.get(entry)}(false, input) end`;
}
