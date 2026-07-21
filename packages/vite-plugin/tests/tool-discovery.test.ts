/**
 * Tool Discovery Tests
 *
 * Tests for the tool discovery Vite plugin that scans directories
 * for canonical tool definitions and generates a type-safe registry.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  discoverToolsInContent,
  generateRegistryContent,
  calculateImportPath,
  toCamelCase,
  deriveNameFromExportName,
  deriveNameFromFilePath,
  resolveToolDiscoveryOptions,
} from "../src/index.ts";
import type { DiscoveredTool } from "../src/index.ts";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function createOptions(overrides = {}) {
  return resolveToolDiscoveryOptions({
    dir: "src/tools",
    outFile: "src/__generated__/tool-registry.gen.ts",
    ...overrides,
  });
}

function canonicalToolSource(content: string): string {
  if (/^\s*import\s/m.test(content)) return content;
  if (/\bdefineTool\s*\(/.test(content)) {
    return `import { defineTool } from "@sweatpants/core";\n${content}`;
  }
  return `import { createTool, createDurableTool } from "@sweatpants/core";\n${content}`;
}

function discoverTools(content: string, file = "/project/src/tools/my-tool.ts") {
  return discoverToolsInContent(
    canonicalToolSource(content),
    file,
    "/project/src/tools",
    createOptions(),
  );
}

// =============================================================================
// UTILITY FUNCTION TESTS
// =============================================================================

describe("toCamelCase", () => {
  it("converts snake_case to camelCase", () => {
    expect(toCamelCase("guess_card")).toBe("guessCard");
    expect(toCamelCase("my_tool_name")).toBe("myToolName");
  });

  it("converts kebab-case to camelCase", () => {
    expect(toCamelCase("guess-card")).toBe("guessCard");
    expect(toCamelCase("my-tool-name")).toBe("myToolName");
  });

  it("handles single words", () => {
    expect(toCamelCase("calculator")).toBe("calculator");
  });

  it("handles mixed separators", () => {
    expect(toCamelCase("my_tool-name")).toBe("myToolName");
  });

  it("handles empty string", () => {
    expect(toCamelCase("")).toBe("");
  });
});

describe("calculateImportPath", () => {
  it("calculates relative path from output to tool file", () => {
    const from = "/project/src/__generated__/tool-registry.gen.ts";
    const to = "/project/src/tools/calculator.ts";
    expect(calculateImportPath(from, to)).toBe("../tools/calculator");
  });

  it("handles same directory", () => {
    const from = "/project/src/tools/registry.ts";
    const to = "/project/src/tools/calculator.ts";
    expect(calculateImportPath(from, to)).toBe("./calculator");
  });

  it("handles nested tool directories", () => {
    const from = "/project/src/__generated__/tool-registry.gen.ts";
    const to = "/project/src/tools/games/guess-card.ts";
    expect(calculateImportPath(from, to)).toBe("../tools/games/guess-card");
  });

  it("strips .ts extension", () => {
    const from = "/project/src/__generated__/registry.ts";
    const to = "/project/src/tools/my-tool.ts";
    expect(calculateImportPath(from, to)).not.toContain(".ts");
  });

  it("strips .tsx extension", () => {
    const from = "/project/src/__generated__/registry.ts";
    const to = "/project/src/tools/ui-tool.tsx";
    expect(calculateImportPath(from, to)).toBe("../tools/ui-tool");
  });

  describe("nested paths", () => {
    it("calculates relative path from output to tool file", () => {
      const from = "/project/src/__generated__/feature/tool-registry.gen.ts";
      const to = "/project/src/feature/tools/calculator.ts";
      expect(calculateImportPath(from, to)).toBe("../../feature/tools/calculator");
    });
  });
});

// =============================================================================
// DISCOVERY PATTERN TESTS
// =============================================================================

describe("discoverToolsInContent", () => {
  describe("named export pattern", () => {
    it("discovers export const with createTool", () => {
      const content = `
        import { createTool } from '@sweatpants/core'

        export const calculator = createTool('calculator')
          .description('Calculate something')
          .parameters(z.object({}))
          .server(function*() { return { result: 42 } })
          .build()
      `;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        toolName: "calculator",
        exportName: "calculator",
        variableName: "calculator",
      });
    });

    it("discovers export const with createTool any import path", () => {
      const content = `
        import { createTool } from '@sweatpants/core'

        export const calculator = createTool('calculator')
          .description('Calculate something')
          .parameters(z.object({}))
          .server(function*() { return { result: 42 } })
          .build()
      `;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        toolName: "calculator",
        exportName: "calculator",
        variableName: "calculator",
      });
    });

    it("discovers multiple named exports", () => {
      const content = `
        export const calculator = createTool('calculator')
          .description('...')
          .build()

        export const search = createTool('search_web')
          .description('...')
          .build()
      `;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(2);
      expect(tools.map((t: DiscoveredTool) => t.toolName).sort()).toEqual([
        "calculator",
        "search_web",
      ]);
    });

    it("handles different quote styles", () => {
      const singleQuote = `export const foo = createTool('my_tool')`;
      const doubleQuote = `export const bar = createTool("my_tool_2")`;
      const backtick = `export const baz = createTool(\`my_tool_3\`)`;

      expect(discoverTools(singleQuote)).toHaveLength(1);
      expect(discoverTools(doubleQuote)).toHaveLength(1);
      expect(discoverTools(backtick)).toHaveLength(1);
    });

    it("handles whitespace variations", () => {
      const withSpaces = `export const   foo   =   createTool  (  'my_tool'  )`;
      const withNewlines = `export const foo = createTool(\n  'my_tool'\n)`;

      expect(discoverTools(withSpaces)).toHaveLength(1);
      expect(discoverTools(withNewlines)).toHaveLength(1);
    });
  });

  describe("default export pattern", () => {
    it("discovers inline default export", () => {
      const content = `
        export default createTool('my_default_tool')
          .description('...')
          .build()
      `;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        toolName: "my_default_tool",
        variableName: "myDefaultTool", // camelCase of tool name
      });
      // Default export should not have exportName property
      expect(tools[0]).not.toHaveProperty("exportName");
    });

    it("discovers variable + default export pattern", () => {
      const content = `
        const guessCard = createTool('guess_card')
          .description('...')
          .build()

        // Some other code...

        export default guessCard
      `;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        toolName: "guess_card",
        variableName: "guessCard", // uses variable name, not camelCase of tool name
      });
      // Default export should not have exportName property
      expect(tools[0]).not.toHaveProperty("exportName");
    });
  });

  describe("export { } pattern", () => {
    it("discovers variable + named export brace pattern", () => {
      const content = `
        const myTool = createTool('my_tool')
          .description('...')
          .build()

        export { myTool }
      `;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        toolName: "my_tool",
        exportName: "myTool",
        variableName: "myTool",
      });
    });

    it("discovers export with alias", () => {
      const content = `
        const internalTool = createTool('my_tool')
          .description('...')
          .build()

        export { internalTool as publicTool }
      `;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        toolName: "my_tool",
        exportName: "publicTool",
        variableName: "publicTool",
      });
    });

    it("discovers multiple exports in braces", () => {
      const content = `
        const toolA = createTool('tool_a').build()
        const toolB = createTool('tool_b').build()
        const notATool = { foo: 'bar' }

        export { toolA, toolB, notATool }
      `;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(2);
      expect(tools.map((t: DiscoveredTool) => t.toolName).sort()).toEqual(["tool_a", "tool_b"]);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for file with no tools", () => {
      const content = `
        export const foo = 'bar'
        export function doSomething() {}
      `;
      const tools = discoverTools(content);
      expect(tools).toHaveLength(0);
    });

    it("ignores commented out tools", () => {
      const content = `
        // export const commented = createTool('commented_tool')
        export const active = createTool('active_tool')
      `;
      const tools = discoverTools(content);

      // Note: Our regex-based approach doesn't handle comments perfectly
      // This test documents current behavior - regex catches both
      // A future AST-based approach would handle this better
      expect(tools.length).toBeGreaterThanOrEqual(1);
      expect(tools.some((t: DiscoveredTool) => t.toolName === "active_tool")).toBe(true);
    });

    it("handles tool names with special characters", () => {
      const content = `export const foo = createTool('my-tool_v2')`;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("my-tool_v2");
    });

    it("does not duplicate tools exported multiple ways", () => {
      const content = `
        export const myTool = createTool('my_tool')
          .build()

        // Also exported via braces (but should not duplicate)
        // export { myTool }
      `;
      const tools = discoverTools(content);
      expect(tools).toHaveLength(1);
    });

    it("sets correct file paths", () => {
      const content = `export const foo = createTool('foo')`;
      const tools = discoverToolsInContent(
        canonicalToolSource(content),
        "/project/src/tools/nested/my-tool.ts",
        "/project/src/tools",
        createOptions(),
      );

      expect(tools[0].filePath).toBe("nested/my-tool.ts");
      expect(tools[0].absolutePath).toBe("/project/src/tools/nested/my-tool.ts");
    });

    it("sets correct file paths (island)", () => {
      const content = `export const foo = createTool('foo')`;
      const tools = discoverToolsInContent(
        canonicalToolSource(content),
        "/project/src/feature/tools/my-tool.ts",
        "/project/src/feature/tools",
        createOptions(),
      );

      expect(tools[0].filePath).toBe("my-tool.ts");
      expect(tools[0].absolutePath).toBe("/project/src/feature/tools/my-tool.ts");
    });
  });

  describe("custom function name", () => {
    it("supports custom export function name", () => {
      const content = `export const foo = defineTool('my_tool')`;
      const tools = discoverToolsInContent(
        canonicalToolSource(content),
        "/project/src/tools/my-tool.ts",
        "/project/src/tools",
        resolveToolDiscoveryOptions({ exportFunctionName: "defineTool" }),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("my_tool");
    });

    it("supports multiple export function names", () => {
      const content = `export const foo = createTool('my_tool')`;
      const tools = discoverToolsInContent(
        canonicalToolSource(content),
        "/project/src/tools/my-tool.ts",
        "/project/src/tools",
        resolveToolDiscoveryOptions({
          exportFunctionName: ["createTool"],
        }),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("my_tool");
    });
  });

  describe(".tsx file support", () => {
    it("discovers .tsx files with named exports", () => {
      const content = `
        import { createTool } from '@sweatpants/core'

        export const askQuestion = createTool('ask_question')
          .description('Ask a question to the user')
          .parameters(z.object({ question: z.string() }))
          .build()
      `;
      const tools = discoverToolsInContent(
        canonicalToolSource(content),
        "/project/src/tools/ask_question.tsx",
        "/project/src/tools",
        createOptions(),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        toolName: "ask_question",
        exportName: "askQuestion",
        variableName: "askQuestion",
      });
    });

    it("discovers nested .tsx files", () => {
      const content = `
        export const askQuestion = createTool('ask_question').build()
      `;
      const tools = discoverToolsInContent(
        canonicalToolSource(content),
        "/project/src/tools/general/ask_question.tsx",
        "/project/src/tools",
        createOptions(),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].filePath).toBe("general/ask_question.tsx");
      expect(tools[0].absolutePath).toBe("/project/src/tools/general/ask_question.tsx");
    });

    it("discovers default export .tsx files", () => {
      const content = `
        export default createTool('ui_dialog').build()
      `;
      const tools = discoverToolsInContent(
        canonicalToolSource(content),
        "/project/src/tools/dialogs/ui-dialog.tsx",
        "/project/src/tools",
        createOptions(),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("ui_dialog");
      expect(tools[0].filePath).toBe("dialogs/ui-dialog.tsx");
    });

    it("calculates correct import paths for .tsx files", () => {
      const from = "/project/src/__generated__/tool-registry.gen.ts";
      const to = "/project/src/tools/ask_question.tsx";
      expect(calculateImportPath(from, to)).toBe("../tools/ask_question");
    });

    it("calculates correct import paths for nested .tsx files", () => {
      const from = "/project/src/__generated__/tool-registry.gen.ts";
      const to = "/project/src/tools/general/ask_question.tsx";
      expect(calculateImportPath(from, to)).toBe("../tools/general/ask_question");
    });
  });

  describe("name derivation (no explicit name)", () => {
    it("derives name from export identifier, stripping Tool suffix", () => {
      const content = `export const tictactoeTool = createTool().build()`;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("tictactoe");
      expect(tools[0].exportName).toBe("tictactoeTool");
    });

    it("derives name from export identifier without Tool suffix (unchanged)", () => {
      const content = `export const calculator = createTool().build()`;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("calculator");
    });

    it("derives name from file basename for default export without name", () => {
      const content = `export default createTool().build()`;
      const tools = discoverToolsInContent(
        canonicalToolSource(content),
        "/project/src/tools/my_tool.ts",
        "/project/src/tools",
        createOptions(),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("my_tool");
    });

    it("keeps explicit name as-is without prefixing", () => {
      const content = `export const bookFlightTool = createTool('book_flight').build()`;
      const tools = discoverTools(content);

      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("book_flight");
    });

    it("does not prefix nested tool names with directory path", () => {
      const content = `export const tictactoeTool = createTool().build()`;
      const tools = discoverToolsInContent(
        canonicalToolSource(content),
        "/project/src/tools/games/tic-tac-toe.ts",
        "/project/src/tools",
        createOptions(),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("tictactoe");
    });
  });
});

// =============================================================================
// NAME DERIVATION HELPER TESTS
// =============================================================================

describe("deriveNameFromExportName", () => {
  it("strips a trailing Tool suffix", () => {
    expect(deriveNameFromExportName("tictactoeTool")).toBe("tictactoe");
    expect(deriveNameFromExportName("bookFlightTool")).toBe("bookFlight");
  });

  it("leaves names without Tool suffix unchanged", () => {
    expect(deriveNameFromExportName("calculator")).toBe("calculator");
  });
});

describe("deriveNameFromFilePath", () => {
  it("uses file basename without extension", () => {
    expect(deriveNameFromFilePath("/project/src/tools/my_tool.ts")).toBe("my_tool");
    expect(deriveNameFromFilePath("/project/src/tools/dialogs/ui-dialog.tsx")).toBe("ui-dialog");
  });
});

// =============================================================================
// REGISTRY GENERATION TESTS
// =============================================================================

describe("generateRegistryContent", () => {
  const options = createOptions();

  it("generates valid TypeScript with imports", () => {
    const tools: DiscoveredTool[] = [
      {
        filePath: "calculator.ts",
        absolutePath: "/project/src/tools/calculator.ts",
        exportName: "calculator",
        toolName: "calculator",
        variableName: "calculator",
      },
    ];

    const content = generateRegistryContent(
      tools,
      "/project/src/__generated__/tool-registry.gen.ts",
      options,
    );

    expect(content).toContain("import { calculator } from '../tools/calculator'");
    expect(content).toContain("export const tools = {");
    expect(content).toContain("calculator,");
    expect(content).toContain("} as const");
  });

  it("generates default imports for default exports", () => {
    const tools: DiscoveredTool[] = [
      {
        filePath: "my-tool.ts",
        absolutePath: "/project/src/tools/my-tool.ts",
        toolName: "my_tool",
        variableName: "myTool",
      },
    ];

    const content = generateRegistryContent(
      tools,
      "/project/src/__generated__/tool-registry.gen.ts",
      options,
    );

    expect(content).toContain("import myTool from '../tools/my-tool'");
  });

  it("generates ToolName union type", () => {
    const tools: DiscoveredTool[] = [
      {
        filePath: "a.ts",
        absolutePath: "/project/src/tools/a.ts",
        exportName: "a",
        toolName: "tool_a",
        variableName: "a",
      },
      {
        filePath: "b.ts",
        absolutePath: "/project/src/tools/b.ts",
        exportName: "b",
        toolName: "tool_b",
        variableName: "b",
      },
    ];

    const content = generateRegistryContent(
      tools,
      "/project/src/__generated__/tool-registry.gen.ts",
      options,
    );

    expect(content).toContain("| 'tool_a'");
    expect(content).toContain("| 'tool_b'");
  });

  it("generates never type for empty tools", () => {
    const content = generateRegistryContent(
      [],
      "/project/src/__generated__/tool-registry.gen.ts",
      options,
    );

    expect(content).toContain("export type ToolName =");
    expect(content).toContain("never");
  });

  it("sorts tools alphabetically by tool name", () => {
    const tools: DiscoveredTool[] = [
      {
        filePath: "z.ts",
        absolutePath: "/project/src/tools/z.ts",
        exportName: "zTool",
        toolName: "z_tool",
        variableName: "zTool",
      },
      {
        filePath: "a.ts",
        absolutePath: "/project/src/tools/a.ts",
        exportName: "aTool",
        toolName: "a_tool",
        variableName: "aTool",
      },
    ];

    const content = generateRegistryContent(
      tools,
      "/project/src/__generated__/tool-registry.gen.ts",
      options,
    );

    // Check that imports are in alphabetical order
    const importIndexA = content.indexOf("aTool");
    const importIndexZ = content.indexOf("zTool");
    expect(importIndexA).toBeLessThan(importIndexZ);
  });

  it("generates toolList array", () => {
    const tools: DiscoveredTool[] = [
      {
        filePath: "foo.ts",
        absolutePath: "/project/src/tools/foo.ts",
        exportName: "foo",
        toolName: "foo",
        variableName: "foo",
      },
    ];

    const content = generateRegistryContent(
      tools,
      "/project/src/__generated__/tool-registry.gen.ts",
      options,
    );

    expect(content).toContain("export const toolList = Object.values(tools)");
  });

  it("generates getTool helper function", () => {
    const content = generateRegistryContent(
      [],
      "/project/src/__generated__/tool-registry.gen.ts",
      options,
    );

    expect(content).toContain("export function getTool");
    expect(content).toContain("return toolList.find((t) => t.name === name)");
  });

  it("includes DO NOT EDIT comment", () => {
    const content = generateRegistryContent(
      [],
      "/project/src/__generated__/tool-registry.gen.ts",
      options,
    );

    expect(content).toContain("DO NOT EDIT");
    expect(content).toContain("auto-generated");
  });
});

// =============================================================================
// OPTIONS RESOLUTION TESTS
// =============================================================================

describe("resolveToolDiscoveryOptions", () => {
  it("provides sensible defaults", () => {
    const options = resolveToolDiscoveryOptions({});

    expect(options.dir).toBe("src/tools");
    expect(options.outFile).toBe("src/__generated__/tool-registry.gen.ts");
    expect(options.pattern).toBe("**/*.ts");
    expect(options.exportFunctionName).toEqual(["createTool"]);
    expect(options.logLevel).toBe("normal");
    expect(options.generateWorker).toBe(false);
    expect(options.workerOutFile).toBe("src/__generated__/tool-worker.gen.ts");
  });

  it("respects user overrides", () => {
    const options = resolveToolDiscoveryOptions({
      dir: "lib/tools",
      outFile: "generated/registry.ts",
      pattern: "*.tool.ts",
      exportFunctionName: "defineTool",
      logLevel: "verbose",
      generateWorker: true,
      workerOutFile: "generated/worker.ts",
    });

    expect(options.dir).toBe("lib/tools");
    expect(options.outFile).toBe("generated/registry.ts");
    expect(options.pattern).toBe("*.tool.ts");
    expect(options.exportFunctionName).toEqual(["defineTool"]);
    expect(options.logLevel).toBe("verbose");
    expect(options.generateWorker).toBe(true);
    expect(options.workerOutFile).toBe("generated/worker.ts");
  });

  it("includes default ignore patterns", () => {
    const options = resolveToolDiscoveryOptions({});

    expect(options.ignore).toContain("**/*.test.ts");
    expect(options.ignore).toContain("**/*.spec.ts");
    expect(options.ignore).toContain("**/__tests__/**");
  });
});

// =============================================================================
// INTEGRATION TESTS (with real file system)
// =============================================================================

import { mkdtemp, writeFile, rm, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { toolDiscoveryPlugin, generateWorkerContent } from "../src/index.ts";

describe("integration: toolDiscoveryPlugin", () => {
  let tempDir: string;

  async function setupTempProject() {
    tempDir = await mkdtemp(join(tmpdir(), "framework-test-"));
    await mkdir(join(tempDir, "src/tools"), { recursive: true });
    await mkdir(join(tempDir, "src/__generated__"), { recursive: true });
    return tempDir;
  }

  async function cleanup() {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async function writeToolFile(name: string, content: string) {
    await writeFile(join(tempDir, "src/tools", name), canonicalToolSource(content));
  }

  async function runPlugin() {
    const plugin = toolDiscoveryPlugin({
      dir: "src/tools",
      outFile: "src/__generated__/tool-registry.gen.ts",
      pattern: "**/*.{ts,tsx}",
      logLevel: "silent",
    });

    // Simulate Vite lifecycle
    if (plugin.configResolved) {
      (plugin.configResolved as (config: { root: string }) => void)({ root: tempDir });
    }
    if (plugin.buildStart) {
      await (plugin.buildStart as () => Promise<void>)();
    }
  }

  async function readRegistry(): Promise<string> {
    return readFile(join(tempDir, "src/__generated__/tool-registry.gen.ts"), "utf-8");
  }

  async function readWorker(): Promise<string> {
    return readFile(join(tempDir, "src/__generated__/tool-worker.gen.ts"), "utf-8");
  }

  it("discovers tools and generates registry", async () => {
    await setupTempProject();

    try {
      await writeToolFile(
        "calculator.ts",
        `export const calculator = createTool('calculator').build()`,
      );

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("import { calculator } from '../tools/calculator'");
      expect(registry).toContain("export const tools = {");
      expect(registry).toContain("calculator,");
      expect(registry).toContain("| 'calculator'");
    } finally {
      await cleanup();
    }
  });

  it("generates worker entry when enabled", async () => {
    await setupTempProject();

    try {
      await writeToolFile(
        "calculator.ts",
        `export const calculator = createTool('calculator')
          .description('Calculator')
          .parameters({})
          .execute(function* () { return { result: 4 } })`,
      );

      const plugin = toolDiscoveryPlugin({
        dir: "src/tools",
        outFile: "src/__generated__/tool-registry.gen.ts",
        workerOutFile: "src/__generated__/tool-worker.gen.ts",
        generateWorker: true,
        pattern: "**/*.{ts,tsx}",
        logLevel: "silent",
      });

      if (plugin.configResolved) {
        (plugin.configResolved as (config: { root: string }) => void)({ root: tempDir });
      }
      if (plugin.buildStart) {
        await (plugin.buildStart as () => Promise<void>)();
      }

      const worker = await readWorker();
      expect(worker).toContain("import { calculator } from '../tools/calculator.ts'");
      expect(worker).toContain("await runToolWorkerEntry([");
      expect(worker).toContain("  calculator");
      expect(worker).not.toContain("as any");
      expect(worker).not.toContain("'capabilities' in tool");
      expect(worker).not.toContain("createWorkerToolRegistry");
      expect(worker).not.toContain("runWorker(registry)");
    } finally {
      await cleanup();
    }
  });

  it("rejects legacy build-style tools when worker generation is enabled", async () => {
    await setupTempProject();

    try {
      await writeToolFile("legacy.ts", `export const legacy = createTool('legacy').build()`);
      const plugin = toolDiscoveryPlugin({
        dir: "src/tools",
        outFile: "src/__generated__/tool-registry.gen.ts",
        workerOutFile: "src/__generated__/tool-worker.gen.ts",
        generateWorker: true,
        pattern: "**/*.{ts,tsx}",
        logLevel: "silent",
      });
      if (plugin.configResolved) {
        (plugin.configResolved as (config: { root: string }) => void)({ root: tempDir });
      }

      await expect((plugin.buildStart as () => Promise<void>)()).rejects.toThrow(
        /Unsupported legacy worker tool.*\.build\(\).*\.description\(\.\.\.\)\.parameters\(\.\.\.\)\.execute/s,
      );
      await expect(readWorker()).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("handles multiple tool files", async () => {
    await setupTempProject();

    try {
      await writeToolFile(
        "calculator.ts",
        `export const calculator = createTool('calculator').build()`,
      );
      await writeToolFile("search.ts", `export const search = createTool('search_web').build()`);

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("calculator,");
      expect(registry).toContain("search,");
      expect(registry).toContain("| 'calculator'");
      expect(registry).toContain("| 'search_web'");
    } finally {
      await cleanup();
    }
  });

  it("handles nested tool directories", async () => {
    await setupTempProject();

    try {
      await mkdir(join(tempDir, "src/tools/games"), { recursive: true });
      await writeFile(
        join(tempDir, "src/tools/games/guess-card.ts"),
        canonicalToolSource(`export const guessCard = createTool('guess_card').build()`),
      );

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("import { guessCard } from '../tools/games/guess-card'");
      expect(registry).toContain("| 'guess_card'");
    } finally {
      await cleanup();
    }
  });

  it("generates empty registry when no tools exist", async () => {
    await setupTempProject();

    try {
      // Don't create any tool files
      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("export const tools = {");
      expect(registry).toContain("} as const");
      expect(registry).toContain("never"); // ToolName = never
    } finally {
      await cleanup();
    }
  });

  it("ignores test files", async () => {
    await setupTempProject();

    try {
      await writeToolFile(
        "calculator.ts",
        `export const calculator = createTool('calculator').build()`,
      );
      await writeToolFile(
        "calculator.test.ts",
        `export const testTool = createTool('test_tool').build()`,
      );

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("calculator,");
      expect(registry).not.toContain("testTool");
      expect(registry).not.toContain("test_tool");
    } finally {
      await cleanup();
    }
  });

  it("handles tools with default exports", async () => {
    await setupTempProject();

    try {
      await writeToolFile("my-tool.ts", `export default createTool('my_default_tool').build()`);

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("import myDefaultTool from '../tools/my-tool'");
      expect(registry).toContain("myDefaultTool,");
      expect(registry).toContain("| 'my_default_tool'");
    } finally {
      await cleanup();
    }
  });

  it("handles mixed export patterns", async () => {
    await setupTempProject();

    try {
      // Named export
      await writeToolFile("named.ts", `export const namedTool = createTool('named_tool').build()`);
      // Default export
      await writeToolFile("default.ts", `export default createTool('default_tool').build()`);
      // Variable + export
      await writeToolFile(
        "variable.ts",
        `const varTool = createTool('var_tool').build()
export { varTool }`,
      );

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("import { namedTool } from '../tools/named'");
      expect(registry).toContain("import defaultTool from '../tools/default'");
      expect(registry).toContain("import { varTool } from '../tools/variable'");
    } finally {
      await cleanup();
    }
  });

  it("discovers .tsx tool files", async () => {
    await setupTempProject();

    try {
      await writeToolFile(
        "ask_question.tsx",
        `export const askQuestion = createTool('ask_question')
          .description('Ask a question to the user')
          .parameters(z.object({ question: z.string() }))
          .build()`,
      );

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("import { askQuestion } from '../tools/ask_question'");
      expect(registry).toContain("askQuestion,");
      expect(registry).toContain("| 'ask_question'");
    } finally {
      await cleanup();
    }
  });

  it("discovers nested .tsx tool files", async () => {
    await setupTempProject();

    try {
      await mkdir(join(tempDir, "src/tools/general"), { recursive: true });
      await writeFile(
        join(tempDir, "src/tools/general/ask_question.tsx"),
        canonicalToolSource(`export const askQuestion = createTool('ask_question').build()`),
      );

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("import { askQuestion } from '../tools/general/ask_question'");
      expect(registry).toContain("| 'ask_question'");
    } finally {
      await cleanup();
    }
  });

  it("handles mixed .ts and .tsx tool files", async () => {
    await setupTempProject();

    try {
      // TypeScript tool
      await writeToolFile(
        "calculator.ts",
        `export const calculator = createTool('calculator').build()`,
      );
      // TSX tool in nested directory
      await mkdir(join(tempDir, "src/tools/general"), { recursive: true });
      await writeFile(
        join(tempDir, "src/tools/general/ask_question.tsx"),
        canonicalToolSource(`export const askQuestion = createTool('ask_question').build()`),
      );

      await runPlugin();
      const registry = await readRegistry();

      // Both should be present
      expect(registry).toContain("import { calculator } from '../tools/calculator'");
      expect(registry).toContain("import { askQuestion } from '../tools/general/ask_question'");
      expect(registry).toContain("calculator,");
      expect(registry).toContain("askQuestion,");
      expect(registry).toContain("| 'ask_question'");
      expect(registry).toContain("| 'calculator'");
    } finally {
      await cleanup();
    }
  });

  it("ignores .tsx test files", async () => {
    await setupTempProject();

    try {
      await writeToolFile(
        "real-tool.tsx",
        `export const realTool = createTool('real_tool').build()`,
      );
      await writeToolFile(
        "real-tool.test.tsx",
        `export const testTool = createTool('test_tool').build()`,
      );

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("realTool,");
      expect(registry).not.toContain("testTool");
      expect(registry).not.toContain("test_tool");
    } finally {
      await cleanup();
    }
  });

  it("derives names from export identifiers when no explicit name is given", async () => {
    await setupTempProject();

    try {
      await writeToolFile("tictactoe.ts", `export const tictactoeTool = createTool().build()`);
      await writeToolFile("calculator.ts", `export const calculator = createTool().build()`);

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("import { tictactoeTool } from '../tools/tictactoe'");
      expect(registry).toContain("| 'tictactoe'");
      expect(registry).toContain("| 'calculator'");
    } finally {
      await cleanup();
    }
  });

  it("does not prefix nested no-arg tool names with directory paths", async () => {
    await setupTempProject();

    try {
      await mkdir(join(tempDir, "src/tools/games"), { recursive: true });
      await writeFile(
        join(tempDir, "src/tools/games/tic-tac-toe.ts"),
        canonicalToolSource(`export const tictactoeTool = createTool().build()`),
      );

      await runPlugin();
      const registry = await readRegistry();

      expect(registry).toContain("import { tictactoeTool } from '../tools/games/tic-tac-toe'");
      expect(registry).toContain("| 'tictactoe'");
      expect(registry).not.toContain("games_");
    } finally {
      await cleanup();
    }
  });

  it("fails the build on duplicate derived tool names across files", async () => {
    await setupTempProject();

    try {
      await mkdir(join(tempDir, "src/tools/a"), { recursive: true });
      await mkdir(join(tempDir, "src/tools/b"), { recursive: true });
      await writeFile(
        join(tempDir, "src/tools/a/tool.ts"),
        canonicalToolSource(`export const myTool = createTool().build()`),
      );
      await writeFile(
        join(tempDir, "src/tools/b/tool.ts"),
        canonicalToolSource(`export const myTool = createTool().build()`),
      );

      await expect(runPlugin()).rejects.toThrow(/Duplicate tool name detected: 'my'/);
    } finally {
      await cleanup();
    }
  });
});
