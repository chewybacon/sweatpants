import { schemeString } from "./scheme-data/values.js";
import { lowerWorkflow, type LowerOptions } from "./lower.js";
import { verifySchemeIR } from "./verify.js";
import type {
  Binding,
  SchemeExpr,
  SchemeFunction,
  SchemeBlock,
  SchemeProgram,
} from "./scheme-ir.js";
import type { WorkflowEmission } from "./types.js";

/** Serialize the verified Scheme dialect; source semantics are already lowered. */
export function emitSchemeIR(program: SchemeProgram): WorkflowEmission {
  verifySchemeIR(program);
  const functions = new Map(program.functions.map((fn) => [fn.id, fn.name]));
  const name = (b: Binding) => b.name;
  const fnBody = (fn: SchemeFunction) => region(fn.body);
  function expr(e: SchemeExpr): string {
    switch (e.kind) {
      case "literal":
        return e.value === null
          ? "(quote json-null)"
          : typeof e.value === "string"
            ? schemeString(e.value)
            : typeof e.value === "boolean"
              ? e.value
                ? "#t"
                : "#f"
              : String(e.value);
      case "read":
        return name(e.binding);
      case "function":
        return functions.get(e.target)!;
      case "json-field":
        return `(json-field ${expr(e.object)} ${schemeString(e.key)})`;
      case "not":
      case "truthy":
        return `(${e.kind} ${expr(e.value)})`;
      case "js-add":
      case "-":
      case "=":
      case "<":
      case ">":
      case "<=":
      case ">=":
        return `(${e.kind} ${expr(e.left)} ${expr(e.right)})`;
      case "set!":
        return `(set! ${name(e.binding)} ${expr(e.value)})`;
      case "object":
        return `(object ${e.entries.map(expr).join(" ")})`;
      case "list":
        return `(list ${e.values.map(expr).join(" ")})`;
      case "lambda":
        return `(lambda (${e.fn.parameters.map(name).join(" ")}) ${fnBody(e.fn)})`;
      case "apply":
        return `(${expr(e.callee)} ${e.args.map(expr).join(" ")})`;
      case "yield-at":
        return `(yield-at ${schemeString(e.site)} ${expr(e.request)})`;
      case "scope":
        return `(scope ${schemeString(e.site)} (lambda () ${fnBody(e.fn)}))`;
      case "ensure":
        return `(ensure (lambda () ${fnBody(e.fn)}))`;
    }
  }
  function region(r: SchemeBlock): string {
    return r.statements
      .map((s) => {
        switch (s.kind) {
          case "define":
            return `(define ${name(s.binding)} ${expr(s.value)})`;
          case "expression":
            return expr(s.value);
          case "workflow-return":
            return `(workflow-return ${expr(s.value)})`;
          case "tail-value":
            return expr(s.value);
          case "workflow-throw":
            return `(workflow-throw ${expr(s.value)})`;
          case "if":
            return `(if ${expr(s.test)} (block ${region(s.consequent)}) (block ${region(s.otherwise)}))`;
          case "while":
            return `(while ${expr(s.test)} (block ${region(s.body)}))`;
          case "try-finally":
            return `(try-finally (block ${region(s.body)}) (block ${region(s.cleanup)}))`;
          case "break":
          case "continue":
            return `(${s.kind})`;
        }
      })
      .join(" ");
  }
  return {
    payload:
      program.functions
        .map((fn) => `(define (${fn.name} ${fn.parameters.map(name).join(" ")}) ${fnBody(fn)})`)
        .join("\n") +
      (program.entryPoint === null
        ? "\n"
        : `\n(${program.entryPoint} #f${program.entryInput ? " %input" : ""})\n`),
    debug: program.debug,
  };
}
/** Standalone experimental frontend, sharing admission, IR, and verification with SDK compilation. */
export function emitWorkflowScheme(source: string, options: LowerOptions = {}) {
  const emitted = emitSchemeIR(lowerWorkflow(source, options));
  return { scheme: emitted.payload, debug: emitted.debug };
}
