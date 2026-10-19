import { expect, it } from "vitest";
import language from "@sweatpants/scheme-runtime/language" with { type: "json" };
import { limits } from "@sweatpants/scheme-runtime";
import { createSchemeReference } from "../reference.ts";

it("documents the built evaluator and the installed capabilities", () => {
  const contract = { name: "custom_lookup", parameters: { type: "object" } };
  const reference = createSchemeReference([contract]);
  for (const name of language.imports) {
    expect(reference).toContain(name);
  }
  for (const procedure of language.procedures) {
    expect(reference).toContain(procedure.signature);
  }
  for (const macro of language.macros) {
    for (const pattern of macro.patterns) {
      expect(reference).toContain(pattern);
    }
  }
  expect(reference).toContain(`${limits.source} source characters`);
  expect(reference).toContain(JSON.stringify([contract]));
  expect(reference).toContain("Omitted input is JSON null");
});

it("executes the documented example through real Scheme effect boundaries", async () => {
  const { run } = await import("effection");
  const { createNodeSchemeDriver } = await import("@sweatpants/scheme-runtime/node");
  const { schemeExamples } = await import("../examples.ts");
  await run(function* () {
    const driver = createNodeSchemeDriver();
    for (const example of schemeExamples) {
      expect(yield* driver.validate(example.program)).toEqual({ valid: true });
      const handle = yield* driver.open({
        source: example.program,
        input: example.input,
        capabilities: ["ask", "decision"],
      });
      expect(yield* driver.advance(handle)).toEqual({
        done: false,
        value: { id: "ask", data: example.input.question },
      });
      expect(
        yield* driver.advance(handle, {
          action: "accept",
          content: { reply: "My bill is wrong" },
          exchange: { messages: [] },
        }),
      ).toEqual({
        done: false,
        value: { id: "decision", data: { ...example.input.classifier, input: "My bill is wrong" } },
      });
      expect(
        yield* driver.advance(handle, { answer: { type: "choice", choice: "billing" } }),
      ).toEqual({ done: true, value: "billing" });
      yield* driver.close(handle);
    }
  });
});
