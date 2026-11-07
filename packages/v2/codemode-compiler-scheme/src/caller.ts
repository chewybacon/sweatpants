import {
  readWorkflowSExpressions,
  workflowSymbolName as symbolName,
  type WorkflowDatum,
} from "@sweatpan.ts/codemode-compiler/syntax";
export const identifier = /^[A-Za-z_][A-Za-z0-9_?!-]*$/;
const forbidden = new Set([
  "quote",
  "yield-at",
  "ensure",
  "scope",
  "set!",
  "workflow-return",
  "workflow-throw",
  "try-finally",
  "while",
  "break",
  "continue",
  "registered-program",
]);
export const reserved = new Set([
  "root",
  ...forbidden,
  "define",
  "lambda",
  "let",
  "let*",
  "if",
  "begin",
  "block",
  "list",
  "object",
  "not",
  "truthy",
  "js-add",
  "string-append",
  "equal?",
  "json-field",
]);
function print(value: WorkflowDatum): string {
  if (Array.isArray(value)) {
    return `(${value.map(print).join(" ")})`;
  }
  if (typeof value === "object") {
    return value.sym;
  }
  if (typeof value === "boolean") {
    return value ? "#t" : "#f";
  }
  return JSON.stringify(value);
}

/** Bounded authored syntax shared by the linked and sampling experiments. */
export function admitSchemeCaller(caller: string) {
  if (caller.length > 12000) {
    throw new Error("Caller exceeds experimental source limit");
  }
  // Validate spelling before the datum reader converts numbers to JavaScript values.
  // This bounded caller profile admits only safe integer literals; exact fractions,
  // decimal/exponent forms and unsafe integers must not silently change semantics.
  for (const token of caller.match(/;[^\n]*|"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) ?? []) {
    if (
      token.startsWith(";") ||
      token.startsWith('"') ||
      ["(", ")", "#t", "#f", "%input"].includes(token) ||
      identifier.test(token)
    ) {
      continue;
    }
    if (
      !/^[+-]?\d+$/.test(token) ||
      !Number.isSafeInteger(Number(token)) ||
      Object.is(Number(token), -0)
    ) {
      throw new Error("Unsupported caller literal: use safe integer literals");
    }
  }
  const forms = readWorkflowSExpressions(caller, true);
  // Reject internal instructions even when nested in caller procedures. Serialize
  // parsed forms so caller text cannot escape the host-owned registration envelope.
  function check(form: WorkflowDatum): void {
    if (Array.isArray(form)) {
      if (forbidden.has(symbolName(form[0]) ?? "")) {
        throw new Error("Unsupported authored caller form");
      }
      form.forEach(check);
    } else if (
      form &&
      typeof form === "object" &&
      !identifier.test(form.sym) &&
      form.sym !== "%input"
    ) {
      throw new Error("Unsupported caller identifier");
    }
  }
  forms.forEach(check);
  if (!forms.length) {
    throw new Error("Empty caller");
  }
  return forms.map(print).join("\n");
}
