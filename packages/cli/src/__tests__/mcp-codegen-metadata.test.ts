import { describe, expect, it } from "vitest";

import { generateTypes } from "../lib/codegen.ts";
import type { McpManifest } from "../lib/fetch-manifest.ts";

const manifest: McpManifest = {
  version: "1.0",
  server: { name: "test", version: "1" },
  mcp: { endpoint: "/mcp", protocolVersion: "2025-11-25" },
  tools: [
    {
      name: "pick_card",
      description: "Pick a card",
      inputSchema: { type: "object", properties: {} },
      _meta: {
        "x-sweatpants": {
          elicits: {
            selected: {
              response: {
                type: "object",
                properties: { card: { type: "string" } },
                required: ["card"],
              },
            },
          },
          requires: { elicitation: true },
        },
      },
    },
  ],
};

describe("MCP x-sweatpants code generation", () => {
  it("preserves elicitation and capability metadata from the server manifest", () => {
    const output = generateTypes(manifest, { includeHeader: false });
    expect(output).toContain("PickCardElicit_Selected_Response");
    expect(output).toContain("selected: {");
    expect(output).toContain("elicitation: true");
  });
});
