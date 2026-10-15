import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { run } from "effection";
import { createNodeSchemeDriver } from "../node.ts";

it("rejects unbound identifiers before effects, including macro-generated references", async () => {
  await run(function* () {
    const driver = createNodeSchemeDriver();
    for (const source of [
      "(begin (ask (object)) missing-name)",
      "(lambda () missing-name)",
      "(let-syntax ((bad (syntax-rules () ((_ x) (missing-name x))))) (bad 1))",
    ]) {
      const result = yield* driver.validate(source);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.message).toContain("missing-name");
    }
    expect(yield* driver.validate("(let ((missing-name 3)) missing-name)")).toEqual({
      valid: true,
    });
    expect(yield* driver.validate("'(missing-name)")).toEqual({ valid: true });
  });
});

it("provides the standard pure helpers used by generated solvers", async () => {
  await run(function* () {
    const driver = createNodeSchemeDriver();
    const handle = yield* driver.open({
      source: "(array (quotient 5827 1000) (cadr (list 1 2 3)) (caddr (list 1 2 3)))",
      capabilities: [],
    });
    expect(yield* driver.advance(handle)).toEqual({ done: true, value: [5, 2, 3] });
  });
});

it("finishes an authored candidate solver within the bounded production fuel budget", async () => {
  const source = readFileSync(new URL("./fixtures/bulls-cows.scm", import.meta.url), "utf8");
  await run(function* () {
    const driver = createNodeSchemeDriver();
    expect(yield* driver.validate(source)).toEqual({ valid: true });
    const handle = yield* driver.open({ source, capabilities: ["ask"] });
    let step = yield* driver.advance(handle);
    let turns = 0;
    while (!step.done) {
      expect(step.value.id).toBe("ask");
      const request = step.value.data as { message: string };
      const guess = request.message.match(/guess is (\d{4})/)?.[1];
      expect(guess).toBeDefined();
      const digits = [...guess!];
      const bulls = digits.filter((d, i) => d === "5827"[i]).length;
      const cows = digits.filter((d) => "5827".includes(d)).length - bulls;
      expect(++turns).toBeLessThanOrEqual(10);
      step = yield* driver.advance(handle, {
        action: "accept",
        content: { reply: `${bulls} ${cows}` },
      });
    }
    expect(step.value).toMatchObject({ status: "solved" });
  });
});
