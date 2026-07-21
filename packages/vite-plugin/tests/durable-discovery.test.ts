import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  discoverToolsInContent,
  generateRegistryContent,
  generateWorkerContent,
  resolveToolDiscoveryOptions,
} from "../src/index.ts";

describe("import-aware ordinary/durable discovery", () => {
  const toolsDir = "/app/src/tools";
  const file = resolve(toolsDir, "mixed.ts");
  const options = resolveToolDiscoveryOptions();
  const tools = discoverToolsInContent(
    `
      import { createTool as ordinaryBuilder, createDurableTool as durableBuilder } from '@sweatpants/core'
      export const ordinary = ordinaryBuilder('same_surface')
      export const durable = durableBuilder('durable_surface')
    `,
    file,
    toolsDir,
    options,
  );

  it("classifies imported aliases by configured module/export provenance", () => {
    expect(tools.map(({ toolName, execution }) => ({ toolName, execution }))).toEqual([
      { toolName: "same_surface", execution: "ordinary" },
      { toolName: "durable_surface", execution: "crank_native" },
    ]);
  });

  it("emits common and split registries while excluding durable programs from ordinary worker output", () => {
    const registry = generateRegistryContent(tools, "/app/src/generated.ts", options);
    const worker = generateWorkerContent(tools, "/app/src/worker.ts", options);
    expect(registry).toContain("export const ordinaryTools");
    expect(registry).toContain("export const durablePrograms");
    expect(registry).toContain("'durable_surface': durable");
    expect(worker).toContain("await runToolWorkerEntry([");
    expect(worker).toContain("  ordinary");
    expect(worker).not.toContain("durable_surface");
  });

  it("ignores a same-text callee imported from unconfigured provenance", () => {
    const discovered = discoverToolsInContent(
      `
        import { createDurableTool } from 'not-sweatpants'
        export const fake = createDurableTool('fake')
      `,
      file,
      toolsDir,
      options,
    );
    expect(discovered).toEqual([]);
  });
});
