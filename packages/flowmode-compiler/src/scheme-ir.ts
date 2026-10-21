import type { EmittedWorkflowDebug } from "./types.js";

declare const identity: unique symbol;
export type Id<K extends string> = string & { readonly [identity]: K };
export type FunctionId = Id<"function">;
export type ValueId = Id<"value">;
export type CellId = Id<"cell">;
export type ScopeId = Id<"scope">;
export type LoopId = Id<"loop">;
export type Origin = { sourceId: string; line: number; column: number };
export type CallableKind = "sync" | "workflow";
/** JSON is the checked, dynamically shaped boundary type, never a host JS value. */
export type ValueType =
  | { kind: "json" | "null" | "string" | "number" | "boolean" | "context" }
  | { kind: "callable"; callable: CallableKind; parameters: ValueType[]; result: ValueType };
export type Binding = {
  id: ValueId | CellId;
  name: string;
  type: ValueType;
  mutable: boolean;
};
/** Typed AST of the executable workflow Scheme dialect. Application kind, IDs,
 * types and capture/scope information are compiler annotations, not extra runtime forms.
 * JavaScript coercions are explicit Scheme operations before either backend runs.
 */
export type SchemeExpr = { origin: Origin } & (
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "read"; binding: Binding }
  | { kind: "function"; target: FunctionId }
  | { kind: "json-field"; object: SchemeExpr; key: string }
  | {
      kind: "js-add" | "-" | "<" | ">" | "<=" | ">=" | "=";
      left: SchemeExpr;
      right: SchemeExpr;
    }
  | { kind: "not" | "truthy"; value: SchemeExpr }
  | { kind: "set!"; binding: Binding; value: SchemeExpr }
  | { kind: "object"; entries: SchemeExpr[] }
  | { kind: "list"; values: SchemeExpr[] }
  | { kind: "lambda"; fn: SchemeFunction }
  | { kind: "apply"; callable: CallableKind; callee: SchemeExpr; args: SchemeExpr[] }
  | { kind: "yield-at"; site: string; request: SchemeExpr }
  | { kind: "scope"; site: string; fn: SchemeFunction }
  | { kind: "ensure"; owner: ScopeId; fn: SchemeFunction }
);
export type SchemeStatement = { origin: Origin } & (
  | { kind: "define"; binding: Binding; value: SchemeExpr }
  | { kind: "expression"; value: SchemeExpr }
  | { kind: "if"; test: SchemeExpr; consequent: SchemeBlock; otherwise: SchemeBlock }
  | { kind: "while"; id: LoopId; test: SchemeExpr; body: SchemeBlock }
  | { kind: "try-finally"; body: SchemeBlock; cleanup: SchemeBlock }
  | { kind: "workflow-return"; target: FunctionId; value: SchemeExpr }
  | { kind: "tail-value"; target: FunctionId; value: SchemeExpr }
  | { kind: "workflow-throw"; value: SchemeExpr }
  | { kind: "break" | "continue"; target: LoopId }
);
export type SchemeBlock = { statements: SchemeStatement[]; exit: "fallthrough" };
export interface SchemeFunction {
  id: FunctionId;
  name: string;
  kind: CallableKind;
  parameters: Binding[];
  result: ValueType;
  captures: Binding[];
  /** Borrowed active scope parameter; ordinary calls do not establish a new scope. */
  scope: ScopeId;
  body: SchemeBlock;
  origin: Origin;
}
export interface SchemeProgram {
  functions: SchemeFunction[];
  debug: EmittedWorkflowDebug;
  entryPoint: string | null;
  entryInput: boolean;
}
export const jsonType: ValueType = { kind: "json" };
export function expressionType(
  expr: SchemeExpr,
  functions: ReadonlyMap<FunctionId, SchemeFunction>,
): ValueType {
  switch (expr.kind) {
    case "literal":
      return {
        kind: expr.value === null ? "null" : (typeof expr.value as "string" | "number" | "boolean"),
      };
    case "read":
      return expr.binding.type;
    case "function": {
      const fn = functions.get(expr.target);
      if (!fn) {
        throw Error(`Unknown IR function ${expr.target}`);
      }
      return functionType(fn);
    }
    case "lambda":
      return functionType(expr.fn);
    case "apply": {
      const callee = expressionType(expr.callee, functions);
      return callee.kind === "callable" ? callee.result : jsonType;
    }
    case "truthy":
    case "not":
      return { kind: "boolean" };
    case "js-add":
      return jsonType;
    case "-":
      return { kind: "number" };
    case "=":
    case "<":
    case ">":
    case "<=":
    case ">=":
      return { kind: "boolean" };
    default:
      return jsonType;
  }
}
export function functionType(fn: SchemeFunction): ValueType {
  return {
    kind: "callable",
    callable: fn.kind,
    parameters: fn.parameters.map((p) => p.type),
    result: fn.result,
  };
}
