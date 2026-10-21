import {
  expressionType,
  type Binding,
  type SchemeExpr,
  type SchemeFunction,
  type SchemeBlock,
  type ValueType,
  type SchemeProgram,
} from "./scheme-ir.js";

/** Structural verification is independent of source admission and runtime schema checks. */
export function verifySchemeIR(program: SchemeProgram): void {
  const functions = new Map(program.functions.map((fn) => [fn.id, fn]));
  const globals = new Set(functions.keys());
  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) {
      throw Error(`Duplicate IR identity ${id}`);
    }
    ids.add(id);
  };
  const compatible = (actual: ValueType, expected: ValueType): boolean =>
    actual.kind === "json" ||
    expected.kind === "json" ||
    (actual.kind === expected.kind &&
      (actual.kind !== "callable" ||
        expected.kind !== "callable" ||
        (actual.callable === expected.callable &&
          actual.parameters.length === expected.parameters.length &&
          compatible(actual.result, expected.result))));
  function verifyFunction(fn: SchemeFunction, parent: ReadonlyMap<string, Binding>): void {
    unique(fn.id);
    unique(fn.scope);
    functions.set(fn.id, fn);
    const available = new Map<string, Binding>();
    for (const capture of fn.captures) {
      if (parent.get(capture.id) !== capture) {
        throw Error(`Invalid IR capture ${capture.name}`);
      }
      available.set(capture.id, capture);
    }
    for (const parameter of fn.parameters) {
      unique(parameter.id);
      available.set(parameter.id, parameter);
    }
    const reference = (binding: Binding, env: ReadonlyMap<string, Binding>) => {
      if (env.get(binding.id) !== binding) {
        throw Error(`Out-of-scope IR binding ${binding.name}`);
      }
    };
    function expr(e: SchemeExpr, env: ReadonlyMap<string, Binding>): void {
      switch (e.kind) {
        case "literal":
          return;
        case "read":
          reference(e.binding, env);
          return;
        case "function":
          if (!globals.has(e.target)) {
            throw Error(`Unknown IR function ${e.target}`);
          }
          return;
        case "json-field":
          expr(e.object, env);
          return;
        case "js-add":
        case "-":
        case "=":
        case "<":
        case ">":
        case "<=":
        case ">=":
          expr(e.left, env);
          expr(e.right, env);
          return;
        case "truthy":
        case "not":
          expr(e.value, env);
          return;
        case "set!":
          reference(e.binding, env);
          if (!e.binding.mutable) {
            throw Error("IR assignment requires a cell");
          }
          expr(e.value, env);
          if (!compatible(expressionType(e.value, functions), e.binding.type)) {
            throw Error("IR assignment type mismatch");
          }
          return;
        case "list":
          e.values.forEach((v) => expr(v, env));
          return;
        case "object":
          e.entries.forEach((entry) => expr(entry, env));
          return;
        case "lambda":
          verifyFunction(e.fn, env);
          return;
        case "scope":
        case "ensure":
          if (fn.kind !== "workflow" || e.fn.kind !== "workflow") {
            throw Error("IR scope requires workflow functions");
          }
          if (e.kind === "ensure" && e.owner !== fn.scope) {
            throw Error("IR cleanup has the wrong owner");
          }
          verifyFunction(e.fn, env);
          return;
        case "yield-at":
          if (fn.kind !== "workflow" || !program.debug.sites[e.site]) {
            throw Error("Invalid IR exchange");
          }
          expr(e.request, env);
          return;
        case "apply": {
          expr(e.callee, env);
          e.args.forEach((a) => expr(a, env));
          const callee = expressionType(e.callee, functions);
          if (callee.kind !== "callable" || callee.callable !== e.callable) {
            throw Error("IR callable kind mismatch");
          }
          if (e.callable === "workflow" && fn.kind !== "workflow") {
            throw Error("IR delegation requires a workflow function");
          }
          if (callee.parameters.length !== e.args.length) {
            throw Error("Helper arity mismatch");
          }
          for (const [i, arg] of e.args.entries()) {
            if (!compatible(expressionType(arg, functions), callee.parameters[i])) {
              throw Error("IR argument type mismatch");
            }
          }
          return;
        }
        default: {
          const invalid: never = e;
          throw Error(`Unknown Scheme expression: ${JSON.stringify(invalid)}`);
        }
      }
    }
    function region(
      r: SchemeBlock,
      inherited: ReadonlyMap<string, Binding>,
      loops: ReadonlySet<string>,
    ): void {
      const env = new Map(inherited);
      for (const s of r.statements) {
        switch (s.kind) {
          case "define":
            expr(s.value, env);
            unique(s.binding.id);
            env.set(s.binding.id, s.binding);
            break;
          case "expression":
            expr(s.value, env);
            break;
          case "tail-value":
          case "workflow-return":
            if (s.kind === "tail-value" && (r !== fn.body || s !== r.statements.at(-1))) {
              throw Error("Scheme tail value must end the function body");
            }
            if (s.target !== fn.id) {
              throw Error("IR return has the wrong function target");
            }
            expr(s.value, env);
            break;
          case "workflow-throw":
            expr(s.value, env);
            break;
          case "break":
          case "continue":
            if (!loops.has(s.target)) {
              throw Error("IR loop exit has the wrong target");
            }
            break;
          case "while":
            unique(s.id);
            expr(s.test, env);
            region(s.body, env, new Set([...loops, s.id]));
            break;
          case "if":
            expr(s.test, env);
            region(s.consequent, env, loops);
            region(s.otherwise, env, loops);
            break;
          case "try-finally":
            region(s.body, env, loops);
            region(s.cleanup, env, loops);
            break;
          default: {
            const invalid: never = s;
            throw Error(`Unknown Scheme statement: ${JSON.stringify(invalid)}`);
          }
        }
      }
    }
    region(fn.body, available, new Set());
  }
  for (const fn of program.functions) {
    verifyFunction(fn, new Map());
  }
}
