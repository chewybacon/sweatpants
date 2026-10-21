import {
  verifySchemeIR,
  type SchemeExpr,
  type SchemeFunction,
  type SchemeBlock,
  type WorkflowEntry,
  type WorkflowEmission,
  type SchemeProgram,
} from "@sweatpants/flowmode-compiler";

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

/** Lowering of the verified Scheme dialect to the restricted Piccolo guest. */
export function emitWorkflowLua(
  program: SchemeProgram,
  definitions: WorkflowEntry[],
): WorkflowEmission {
  verifySchemeIR(program);
  if (definitions.length !== 1) {
    throw Error("Lua spike requires one exported workflow");
  }
  const entry = program.functions.find((fn) => fn.name === definitions[0].entry);
  if (
    !entry ||
    entry.parameters.length !== 2 ||
    entry.parameters[0].name !== "ctx" ||
    entry.parameters[1].name !== "input"
  ) {
    throw Error("Unknown workflow entry");
  }
  const fail = (
    node: { origin: { sourceId: string; line: number; column: number } },
    kind: string,
  ): never => {
    throw Object.assign(Error(`Unsupported Lua workflow operation: ${kind}`), {
      position: { ...node.origin, column: node.origin.column + 1 },
    });
  };
  let temporary = 0;
  const fresh = () => `temporary_${temporary++}`;
  // Materialize operands in source order. Lua argument evaluation is not the source contract.
  function expr(e: SchemeExpr, output: string[]): string {
    const materialize = (value: SchemeExpr): string => {
      const result = expr(value, output),
        name = fresh();
      output.push(`local ${name} = ${result}`);
      return name;
    };
    switch (e.kind) {
      case "literal":
        return e.value === null
          ? "workflow.null"
          : typeof e.value === "string"
            ? quote(e.value)
            : String(e.value);
      case "read":
        return e.binding.id;
      case "function":
        return e.target;
      case "json-field":
        return `${materialize(e.object)}[${quote(e.key)}]`;
      case "truthy":
        return `truthy(${materialize(e.value)})`;
      case "not":
        return `(${materialize(e.value)} == false)`;
      case "js-add":
      case "-":
      case "=":
      case "<":
      case ">":
      case "<=":
      case ">=": {
        const left = materialize(e.left),
          right = materialize(e.right);
        if (e.kind === "js-add") {
          return `add(${left}, ${right})`;
        }
        if (e.kind === "=") {
          return `equal(${left}, ${right})`;
        }
        return `(${left} ${e.kind} ${right})`;
      }
      case "lambda":
        return closure(e.fn);
      case "apply": {
        const callee = materialize(e.callee),
          args = e.args.map(materialize);
        return `${callee}(active_scope${args.length ? ", " : ""}${args.join(", ")})`;
      }
      case "yield-at": {
        const request = e.request;
        if (request.kind !== "list" || request.values.length !== 3) {
          return fail(e, "yield-at");
        }
        const [operation, key, input] = request.values;
        if (
          operation.kind !== "literal" ||
          operation.value !== "elicit" ||
          key.kind !== "literal" ||
          typeof key.value !== "string"
        ) {
          return fail(e, "yield-at");
        }
        const message = materialize(input);
        return `workflow.effect(${quote(e.site)}, {binding = ${quote(JSON.stringify(["elicit", key.value]))}, input = {message = ${message}}})`;
      }
      default:
        return fail(e, e.kind);
    }
  }
  function closure(fn: SchemeFunction): string {
    return `(function(active_scope${fn.parameters.length ? ", " : ""}${fn.parameters.map((p) => p.id).join(", ")})\n${body(fn.body, fn, true)}\nend)`;
  }
  function body(region: SchemeBlock, fn: SchemeFunction, root: boolean, cleanup = false): string {
    const output: string[] = [];
    for (const s of region.statements) {
      switch (s.kind) {
        case "define": {
          const value = expr(s.value, output);
          output.push(`local ${s.binding.id} = ${value}`);
          break;
        }
        case "if": {
          const test = expr(s.test, output);
          output.push(
            `if ${test} ~= false then`,
            body(s.consequent, fn, false, cleanup),
            "else",
            body(s.otherwise, fn, false, cleanup),
            "end",
          );
          break;
        }
        case "tail-value":
        case "workflow-return":
          if (cleanup) {
            return fail(s, "cleanup return");
          }
          output.push(`do return ${expr(s.value, output)} end`);
          break;
        case "workflow-throw":
          output.push(`error(${expr(s.value, output)})`);
          break;
        case "expression": {
          const e = s.value;
          if (e.kind === "ensure") {
            if (!root || cleanup || e.owner !== fn.scope) {
              return fail(e, "ensure");
            }
            const release = body(e.fn.body, e.fn, false, true);
            output.push(`active_scope[#active_scope + 1] = function()\n${release}\nend`);
            break;
          }
          if (e.kind === "set!") {
            const value = expr(e.value, output);
            output.push(`${e.binding.id} = ${value}`);
          } else if (e.kind === "apply" || e.kind === "yield-at") {
            const value = expr(e, output);
            output.push(value);
          } else {
            return fail(e, e.kind);
          }
          break;
        }
        default:
          return fail(s, s.kind);
      }
    }
    if (root && !cleanup) {
      output.push('error("Compiled workflow fell through without a JSON return")');
    }
    return output.join("\n");
  }
  const declarations = [`local ${program.functions.map((fn) => fn.id).join(", ")}`];
  for (const fn of program.functions) {
    declarations.push(`${fn.id} = ${closure(fn)}`);
  }
  const payload = `local function truthy(value)
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
${declarations.join("\n")}
local function drain(active_scope)
local cleanup = active_scope[#active_scope]
if cleanup == nil then return end
active_scope[#active_scope] = nil
return workflow.scope(cleanup, function() return drain(active_scope) end)
end
return function(input)
local active_scope = {}
return workflow.scope(function() return ${entry.id}(active_scope, false, input) end, function() return drain(active_scope) end)
end`;
  return { payload, debug: program.debug };
}
