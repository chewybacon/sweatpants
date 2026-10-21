import { expect, test } from "vitest";
import { lowerWorkflow, verifySchemeIR } from "../index.js";

test("verification rejects non-dialect operations from an untyped IR transform", () => {
  const program = lowerWorkflow('function* workflow(ctx) { "use workflow"; return 0; }');
  const returned = program.functions[0].body.statements[0];
  if (returned.kind !== "tail-value") {
    throw Error("Expected final value");
  }
  Object.assign(returned.value, { kind: "binary", operator: "+" });
  expect(() => verifySchemeIR(program)).toThrow("Unknown Scheme expression");
});

test("an implicit Scheme result cannot be moved before other function forms", () => {
  const program = lowerWorkflow('function* workflow(ctx) { "use workflow"; return 0; }');
  const body = program.functions[0].body;
  body.statements.push({
    kind: "expression",
    origin: program.functions[0].origin,
    value: { kind: "literal", value: 1, origin: program.functions[0].origin },
  });
  expect(() => verifySchemeIR(program)).toThrow("Scheme tail value must end the function body");
});
