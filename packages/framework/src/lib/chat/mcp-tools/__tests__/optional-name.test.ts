/**
 * Tool builder optional-name API tests.
 *
 * Verifies:
 * - REQ-001: createMcpTool() accepts zero arguments (does not throw).
 * - REQ-002: createIsomorphicTool() accepts zero arguments (does not throw).
 * - REQ-003: explicit name override is respected.
 * - REQ-029: createMcpTool() without the vite plugin does not throw and
 *   produces a tool with a name field (empty placeholder).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createMcpTool } from "../mcp-tool-builder.ts";
import { createIsomorphicTool } from "../../isomorphic-tools/builder.ts";

describe("createMcpTool optional name", () => {
  it("compiles and builds with zero arguments (name placeholder)", () => {
    const tool = createMcpTool()
      .description("test")
      .parameters(z.object({}))
      .elicits({})
      .execute(function* () {
        return "ok";
      });
    // Without the vite plugin, the name is an empty-string placeholder.
    expect(tool.name).toBe("");
  });

  it("respects an explicit name override", () => {
    const tool = createMcpTool("custom_name")
      .description("test")
      .parameters(z.object({}))
      .elicits({})
      .execute(function* () {
        return "ok";
      });
    expect(tool.name).toBe("custom_name");
  });

  it("does not throw when called with no argument and no builder chain", () => {
    expect(() => createMcpTool()).not.toThrow();
  });
});

describe("createIsomorphicTool optional name", () => {
  it("compiles and builds with zero arguments (name placeholder)", () => {
    const tool = createIsomorphicTool()
      .description("test")
      .parameters(z.object({}))
      .context("agent")
      .server(function* () {
        return { result: 0 };
      })
      .build();
    expect(tool.name).toBe("");
  });

  it("respects an explicit name override", () => {
    const tool = createIsomorphicTool("my_tool")
      .description("test")
      .parameters(z.object({}))
      .context("agent")
      .server(function* () {
        return { result: 0 };
      })
      .build();
    expect(tool.name).toBe("my_tool");
  });

  it("does not throw when called with no argument", () => {
    expect(() => createIsomorphicTool()).not.toThrow();
  });
});
