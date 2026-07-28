import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const frameworkRoot = resolve(process.cwd());

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      return listSourceFiles(full);
    }
    return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

describe("framework package boundaries", () => {
  it("exports only scope-driven framework subpaths", () => {
    const pkg = readJson(resolve(frameworkRoot, "package.json")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual([
      ".",
      "./chat",
      "./chat/browser-rendering",
      "./chat/mcp-tools",
      "./deployment",
      "./server",
      "./server/testing",
    ]);
    const removedSubpath = `${"./chat/"}${[String.fromCharCode(105, 115, 111, 109, 111, 114, 112, 104, 105, 99), "tools"].join("-")}`;
    expect(Object.keys(pkg.exports)).not.toContain(removedSubpath);
  });

  it("does not declare concrete adapter/UI/runtime production dependencies", () => {
    const pkg = readJson(resolve(frameworkRoot, "package.json")) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = Object.keys(pkg.dependencies ?? {});
    expect(dependencies).not.toContain("@earendil-works/pi-ai");
    expect(dependencies).not.toContain("@aws-sdk/client-bedrock-agentcore");
    expect(dependencies).not.toContain("@sweatpants/model-provider-pi-ai");
    expect(dependencies).not.toContain("@sweatpants/tool-runtime-local");
    expect(dependencies).not.toContain("@sweatpants/tool-runtime-agentcore");
    expect(dependencies).not.toContain("react");
    expect(dependencies).not.toContain("vite");
  });

  it("does not publicly export removed provider/runtime/react compatibility names", () => {
    const chatIndex = readFileSync(resolve(frameworkRoot, "src/lib/chat/index.ts"), "utf8");
    expect(chatIndex).not.toContain("ProviderContext");
    expect(chatIndex).not.toContain("RuntimeContext");
    expect(chatIndex).not.toContain("RuntimeModelContext");
    expect(chatIndex).not.toContain("RuntimeStreamConfigContext");
    expect(chatIndex).not.toContain("ChatProvider");
  });

  it("does not publicly export legacy session-style tool runtime helper types from framework chat root", () => {
    const runtimeSource = readFileSync(
      resolve(frameworkRoot, "src/lib/chat/tool-runtime.ts"),
      "utf8",
    );
    expect(runtimeSource).not.toContain("export type ToolRuntimeToolSchema");
    expect(runtimeSource).not.toContain("export interface ToolSessionRef");
    expect(runtimeSource).not.toContain("export type ToolSessionEvent");
    expect(runtimeSource).not.toContain("export interface ToolSession");
    expect(runtimeSource).not.toContain("export interface StartToolCallRequest");
  });

  it("does not publicly export legacy MCP tool context/result/config alias names", () => {
    const mcpToolsIndex = readFileSync(
      resolve(frameworkRoot, "src/lib/chat/mcp-tools/index.ts"),
      "utf8",
    );
    expect(mcpToolsIndex).not.toContain("\n  McpToolContext,");
    expect(mcpToolsIndex).not.toContain("\n  McpToolContextWithElicits,");
    expect(mcpToolsIndex).not.toContain("\n  ElicitResult,");
    expect(mcpToolsIndex).not.toContain("\n  ElicitConfig,");
  });

  it("does not publicly export tool authoring builders from framework", () => {
    const indexes = [
      resolve(frameworkRoot, "src/lib/chat/index.ts"),
      resolve(frameworkRoot, "src/lib/chat/mcp-tools/index.ts"),
    ];
    const forbidden = [
      ["create", "Tool"].join(""),
      ["create", "Mcp", "Tool"].join(""),
      ["create", "MCP", "Tool"].join(""),
      ["Mcp", "Tool", "Builder", "Base"].join(""),
      ["MCP", "Tool", "Builder", "Base"].join(""),
    ];

    for (const indexPath of indexes) {
      const source = readFileSync(indexPath, "utf8");
      for (const name of forbidden) {
        expect(source, `${indexPath} must not export ${name}`).not.toContain(`export { ${name}`);
      }
    }
  });

  it("does not publicly export legacy finalized tool runtime type names", () => {
    const indexes = [
      resolve(frameworkRoot, "src/lib/chat/mcp-tools/index.ts"),
      resolve(frameworkRoot, "src/lib/chat/browser-rendering/index.ts"),
    ];
    const forbidden = [
      ["Finalized", "McpTool"].join(""),
      ["Finalized", "McpToolWithElicits"].join(""),
      ["Finalized", "MCPTool"].join(""),
      ["Finalized", "Isomorphic", "Tool"].join(""),
    ];

    for (const indexPath of indexes) {
      const source = readFileSync(indexPath, "utf8");
      for (const name of forbidden) {
        expect(source, `${indexPath} must not export ${name}`).not.toContain(name);
      }
    }
  });

  it("does not publicly export legacy initializer hook server API", () => {
    const serverIndex = readFileSync(resolve(frameworkRoot, "src/server/index.ts"), "utf8");
    const durableIndex = readFileSync(
      resolve(frameworkRoot, "src/handler/durable/index.ts"),
      "utf8",
    );
    const durableTypes = readFileSync(
      resolve(frameworkRoot, "src/handler/durable/types.ts"),
      "utf8",
    );

    const initializerHook = ["Initializer", "Hook"].join("");
    const initializerContext = ["Initializer", "Context"].join("");
    const initializerHooks = ["initializer", "Hooks"].join("");

    expect(serverIndex).not.toContain(initializerHook);
    expect(serverIndex).not.toContain(initializerContext);
    expect(durableIndex).not.toContain(initializerHook);
    expect(durableIndex).not.toContain(initializerContext);
    expect(durableTypes).not.toContain(initializerHooks);
  });

  it("does not import concrete adapter/UI/runtime packages from framework source", () => {
    const forbidden = [
      "@earendil-works/pi-ai",
      "@aws-sdk/client-bedrock-agentcore",
      "@sweatpants/model-provider-pi-ai",
      "@sweatpants/tool-runtime-local",
      "@sweatpants/tool-runtime-agentcore",
      "react",
      "vite",
    ];
    const productionFiles = listSourceFiles(resolve(frameworkRoot, "src"))
      .filter((file) => !file.includes("__tests__"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => !file.endsWith(".test.tsx"));

    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of forbidden) {
        expect(source, `${file} must not import ${specifier}`).not.toContain(`from '${specifier}`);
        expect(source, `${file} must not import ${specifier}`).not.toContain(`from "${specifier}`);
      }
    }
  });

  it("does not keep legacy provider/runtime or local tool runtime implementation files in framework", () => {
    for (const file of [
      "src/lib/chat/providers/types.ts",
      "src/lib/chat/providers/contexts.ts",
      "src/lib/chat/providers/config.ts",
      "src/lib/chat/runtime/contexts.ts",
      "src/handler/index.ts",
      "src/handler/durable/session-contract-adapter.ts",
      "src/lib/chat/mcp-tools/session/index.ts",
      "src/lib/chat/mcp-tools/session/types.ts",
      "src/lib/chat/mcp-tools/session/event-log.ts",
      "src/lib/chat/mcp-tools/session/in-memory-store.ts",
      "src/lib/chat/mcp-tools/session/session-registry.ts",
      "src/lib/chat/mcp-tools/session/setup.ts",
      "src/lib/chat/mcp-tools/session/tool-session.ts",
      "src/lib/chat/mcp-tools/session/worker-tool-session.ts",
      "src/lib/chat/mcp-tools/session/worker-runner.ts",
      "src/lib/chat/mcp-tools/session/worker-session-api.ts",
      "src/lib/chat/mcp-tools/session/worker-types.ts",
    ]) {
      expect(existsSync(resolve(frameworkRoot, file)), file).toBe(false);
    }
  });
});
