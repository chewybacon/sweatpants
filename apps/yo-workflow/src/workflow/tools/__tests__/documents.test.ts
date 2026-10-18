import { expect, it } from "vitest";
import { createSchemeTool } from "../../scheme/tool.ts";
import { presentChoices } from "../documents.ts";

it("publishes the choice completion envelope to workflow authors", () => {
  const output = presentChoices.artifacts.output?.outputProjection;
  expect(output).toMatchObject({
    anyOf: [
      {
        properties: {
          action: { const: "accept" },
          content: { properties: { id: { type: "string" } }, required: ["id"] },
        },
        required: ["action", "content", "exchange"],
      },
      { properties: { action: { const: "decline" } }, required: ["action"] },
      { properties: { action: { const: "cancel" } }, required: ["action"] },
      { properties: { action: { const: "error" } }, required: ["action", "diagnostic"] },
    ],
  });
  const workflow = createSchemeTool([presentChoices]);
  expect(workflow.description).toContain(`"output":${JSON.stringify(output)}`);
});
