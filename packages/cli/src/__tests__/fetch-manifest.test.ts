import { describe, expect, it } from "vitest";

import { parseMcpManifest } from "../lib/fetch-manifest.ts";

const validManifest = {
  version: "1.0",
  server: { name: "server", version: "1.0.0" },
  mcp: { endpoint: "/mcp", protocolVersion: "2025-11-25" },
  tools: [
    {
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object", properties: {} },
      _meta: { "x-sweatpants": { requires: { elicitation: false } } },
    },
  ],
};

describe("parseMcpManifest", () => {
  it("parses a complete manifest", () => {
    expect(parseMcpManifest(validManifest)).toEqual(validManifest);
  });

  it.each([
    ["missing server", { ...validManifest, server: undefined }],
    ["missing MCP metadata", { ...validManifest, mcp: undefined }],
    ["missing tool description", { ...validManifest, tools: [{ name: "echo", inputSchema: {} }] }],
    ["unknown top-level field", { ...validManifest, unexpected: true }],
    [
      "unknown nested field",
      {
        ...validManifest,
        tools: [{ ...validManifest.tools[0], unexpected: true }],
      },
    ],
    [
      "malformed elicitation schema",
      {
        ...validManifest,
        tools: [
          {
            ...validManifest.tools[0],
            _meta: { "x-sweatpants": { elicits: { choose: { response: "not-json-schema" } } } },
          },
        ],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => parseMcpManifest(value)).toThrow("MCP manifest has an invalid closed shape");
  });
});
