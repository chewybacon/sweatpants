import type {
  SchemeExpr,
  SchemeFunction,
  FunctionId,
  SchemeBlock,
  SchemeProgram,
} from "./scheme-ir.js";
/** Function values count as references even when they are returned or captured. */
export function retainReachableFunctions(program: SchemeProgram, entries: string[]): void {
  const functions = new Map(program.functions.map((fn) => [fn.id, fn]));
  const reachable = new Set<FunctionId>(),
    owners = new Set<string>();
  function expr(e: SchemeExpr): void {
    switch (e.kind) {
      case "function":
        visit(functions.get(e.target)!);
        break;
      case "lambda":
      case "scope":
      case "ensure":
        visit(e.fn);
        break;
      case "json-field":
        expr(e.object);
        break;
      case "truthy":
      case "not":
      case "set!":
        expr(e.value);
        break;
      case "js-add":
      case "-":
      case "=":
      case "<":
      case ">":
      case "<=":
      case ">=":
        expr(e.left);
        expr(e.right);
        break;
      case "apply":
        expr(e.callee);
        e.args.forEach(expr);
        break;
      case "yield-at":
        expr(e.request);
        break;
      case "list":
        e.values.forEach(expr);
        break;
      case "object":
        e.entries.forEach(expr);
        break;
    }
  }
  function region(r: SchemeBlock): void {
    for (const s of r.statements) {
      switch (s.kind) {
        case "define":
        case "expression":
        case "tail-value":
        case "workflow-return":
        case "workflow-throw":
          expr(s.value);
          break;
        case "if":
          expr(s.test);
          region(s.consequent);
          region(s.otherwise);
          break;
        case "while":
          expr(s.test);
          region(s.body);
          break;
        case "try-finally":
          region(s.body);
          region(s.cleanup);
          break;
      }
    }
  }
  function visit(fn: SchemeFunction): void {
    if (reachable.has(fn.id)) {
      return;
    }
    reachable.add(fn.id);
    owners.add(fn.name);
    region(fn.body);
  }
  program.functions.filter((fn) => entries.includes(fn.name)).forEach(visit);
  program.functions = program.functions.filter((fn) => reachable.has(fn.id));
  program.debug.sites = Object.fromEntries(
    Object.entries(program.debug.sites).filter(([, site]) => owners.has(site.function)),
  );
  program.debug.locations = Object.fromEntries(
    Object.entries(program.debug.locations).filter(([name]) => owners.has(name)),
  );
}
