import { expect, it } from "vitest";
import { run } from "effection";
import { createWorkflowExposure, programs } from "../agent.ts";
import { workflowLanguage } from "../language.ts";

it.each(["scheme", "lua"] as const)(
  "exposes only the selected %s authoring tool",
  async (language) => {
    const policy = createWorkflowExposure(language);
    // Only the public definition is read by this exposure policy.
    const entries = programs.map((tool) => ({ definition: { name: tool.name } })) as Parameters<
      typeof policy.filter
    >[0]["entries"];
    const exposed = await run(() => policy.filter({ phase: "outer-chat", entries }));
    expect(exposed.map((tool) => tool.name)).toEqual([language]);
  },
);
it("rejects unknown languages instead of silently selecting Scheme", () => {
  expect(workflowLanguage(null)).toBe("scheme");
  expect(() => workflowLanguage("javascript")).toThrow("Unavailable workflow language");
});
