import { expect, it } from "vitest";
import { run } from "effection";
import { checkSchemeProgram, SchemeEvaluationPort, schemeDiagnostic } from "../evaluation.ts";
import { createNodeSchemeDriver } from "../node.ts";

it("checks without executing effects and states the limits of validation", async () => {
  await run(function* () {
    yield* SchemeEvaluationPort.installDriver(createNodeSchemeDriver());
    const result = yield* checkSchemeProgram({ source: "(ask (object))" });
    expect(result).toEqual({
      valid: true,
      checks: {
        checked: [
          "syntax",
          "macro-expansion",
          "bindings",
          "known-call-arities",
          "input-serialization",
        ],
        unchecked: ["runtime-data-shapes", "effect-requests", "termination"],
      },
    });
    const invalid = yield* checkSchemeProgram({ source: "(let ()\n (ask (object))" });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.diagnostic.code).toBe("E_READ");
      expect(invalid.diagnostic.location).toMatchObject({ line: 2 });
    }
  });
});

it("preserves input across field access and reports omitted input precisely", async () => {
  await run(function* () {
    const driver = createNodeSchemeDriver();
    const source = '(field input "nameSchema")';
    const input = { nameSchema: { type: "object" } };
    const valid = yield* driver.open({ source, input, capabilities: [] });
    expect(yield* driver.advance(valid)).toEqual({ done: true, value: input.nameSchema });
    yield* driver.close(valid);
    const omitted = yield* driver.open({ source, capabilities: [] });
    let failure: unknown;
    try {
      yield* driver.advance(omitted);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const diagnostic = schemeDiagnostic((failure as Error).message, "execution");
    expect(diagnostic.code).toBe("E_EXPECTED_OBJECT");
    expect(diagnostic.message).toContain('received null; key "nameSchema"');
    expect(diagnostic.location).toBeUndefined();
    yield* driver.close(omitted);
  });
});

it("does not mistake Hoot implementation locations for authored source", () => {
  const diagnostic = schemeDiagnostic(
    '#<&source file: "hoot/errors.scm" line: 95 column: 22>',
    "execution",
  );
  expect(diagnostic.location).toBeUndefined();
});

it("returns serialization failures without requiring an evaluator", async () => {
  const result = await run(function* () {
    return yield* checkSchemeProgram({ source: "input", input: Number.MAX_SAFE_INTEGER + 1 });
  });
  expect(result).toMatchObject({
    valid: false,
    diagnostic: { code: "E_INPUT", phase: "input", message: "Unsafe JSON number" },
  });
});

it("checks known lexical arities after expansion without confusing shadowed names", async () => {
  await run(function* () {
    const driver = createNodeSchemeDriver();
    for (const source of [
      "(ask (object) (object))",
      "(let () (define (sum x y) (+ x y)) (sum 1))",
      "(let-syntax ((bad (syntax-rules () ((_ x) (ask x x))))) (bad (object)))",
    ]) {
      const result = yield* driver.validate(source);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.message).toContain("E_ARITY");
      }
    }
    for (const source of [
      "(let ((ask (lambda (x y) (+ x y)))) (ask 1 2))",
      "(let () (define (sum . xs) (apply + xs)) (sum 1 2 3))",
      "(let ((call (lambda (f) (f 1)))) (call (lambda (x) x)))",
    ]) {
      expect(yield* driver.validate(source)).toEqual({ valid: true });
    }
  });
});
