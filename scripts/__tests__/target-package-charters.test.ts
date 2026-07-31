import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function productionSource(packageName: string): string {
  const sourceRoot = resolve(root, "packages", packageName, "src");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "__tests__" && entry !== "testing") visit(path);
      } else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".spec.ts")) {
        files.push(path);
      }
    }
  };
  visit(sourceRoot);
  return files
    .sort()
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

function sourceTree(directory: string): string {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = resolve(current, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "dist" && entry !== "node_modules") visit(path);
      } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
        files.push(path);
      }
    }
  };
  visit(directory);
  return files
    .sort()
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

function expectNoMatches(source: string, patterns: readonly RegExp[]): void {
  for (const pattern of patterns) expect(source).not.toMatch(pattern);
}

describe("target package charters", () => {
  it("keeps Journal Authority free of Host, history, chat, and concrete Redis adapters", () => {
    expectNoMatches(productionSource("journal-authority"), [
      /from ["']@sweatpants\/(?:agent-host|history-store|chat-core|execution-store-redis)/,
      /from ["'](?:node:http|redis|react)["']/,
    ]);
  });

  it("keeps History Store generic over bounded-context entry schemas", () => {
    expectNoMatches(productionSource("history-store"), [
      /from ["']@sweatpants\/(?:chat-core|a2a|tool-session|agent-host)/,
      /ChatMessage|ForeignA2A|McpMessage/,
    ]);
  });

  it("keeps Model Provider neutral and concrete adapters off Chat Core", () => {
    expectNoMatches(productionSource("model-provider"), [
      /from ["']@sweatpants\/(?:chat-core|model-provider-pi-ai|durable-chat-runtime|agent-host)/,
      /from ["'](?:node:http|redis|react)["']/,
    ]);
    expect(productionSource("model-provider-pi-ai")).not.toMatch(/from ["']@sweatpants\/chat-core/);
  });

  it("keeps Tool Runtime neutral and under one contract owner", () => {
    expectNoMatches(productionSource("tool-runtime"), [
      /from ["']@sweatpants\/(?:chat-core|tool-session|durable-chat-runtime)/,
      /from ["'](?:node:http|redis|react)["']/,
    ]);

    const declarations = new Map(
      [
        "PortableToolDefinition",
        "ToolInventoryEntry",
        "ToolRuntime",
        "ToolCall",
        "ToolResultMessage",
        "ElicitExchangeCompletion",
        "SampleExchangeCompletion",
      ].map((name) => [name, [] as string[]]),
    );
    for (const packageName of readdirSync(resolve(root, "packages"))) {
      const sourceRoot = resolve(root, "packages", packageName, "src");
      if (!existsSync(sourceRoot)) continue;
      const visit = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
          const path = resolve(directory, entry);
          if (statSync(path).isDirectory()) {
            if (entry !== "dist" && entry !== "node_modules") visit(path);
            continue;
          }
          if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
          const source = readFileSync(path, "utf8");
          for (const name of declarations.keys()) {
            if (new RegExp(`export (?:interface|type) ${name}\\b`).test(source)) {
              declarations.get(name)?.push(path.replace(`${root}/`, ""));
            }
          }
          expect(source, path).not.toMatch(/\bWire(?:Elicit|Sample)[A-Za-z]*\b/);
          expect(source, path).not.toMatch(
            /@sweatpants\/tool-session\/(?:chat-runtime|tool-inventory)/,
          );
          expect(source, path).not.toMatch(/input\.result as ElicitExchangeCompletion/);
          expect(source, path).not.toMatch(/response\.content as T\b/);
        }
      };
      visit(sourceRoot);
    }

    expect(declarations.get("PortableToolDefinition")).toEqual([
      "packages/tool-runtime/src/contract.ts",
    ]);
    expect(declarations.get("ToolInventoryEntry")).toEqual([
      "packages/tool-runtime/src/contract.ts",
    ]);
    expect(declarations.get("ToolRuntime")).toEqual(["packages/tool-runtime/src/contract.ts"]);
    expect(declarations.get("ToolCall")).toEqual(["packages/model-provider/src/types.ts"]);
    expect(declarations.get("ToolResultMessage")).toEqual(["packages/model-provider/src/types.ts"]);
    expect(declarations.get("ElicitExchangeCompletion")).toEqual([
      "packages/agent-sdk/src/tool/types.ts",
    ]);
    expect(declarations.get("SampleExchangeCompletion")).toEqual([
      "packages/agent-sdk/src/tool/types.ts",
    ]);
    for (const packageName of readdirSync(resolve(root, "packages"))) {
      if (packageName === "model-provider-pi-ai") continue;
      const sourceRoot = resolve(root, "packages", packageName, "src");
      if (existsSync(sourceRoot)) {
        expect(productionSource(packageName), packageName).not.toMatch(
          /role:\s*["']toolResult["']/,
        );
      }
    }
    expect(existsSync(resolve(root, "packages/tool-session/src/chat-runtime.ts"))).toBe(false);
    expect(existsSync(resolve(root, "packages/tool-session/src/tool-inventory.ts"))).toBe(false);
  });

  it("keeps Chat Core free of hosting, authority persistence, Redis, and MCP handlers", () => {
    expectNoMatches(productionSource("chat-core"), [
      /from ["']@sweatpants\/(?:agent-host|journal-authority|execution-store-redis)/,
      /@sweatpants\/tool-session\/mcp\/handler/,
      /from ["'](?:node:http|redis)["']/,
      /\b(?:OllamaChatRequest|OllamaChatChunk|ClientToolSchema)\b/,
      /message\.replay\??\.toolName|replay:\s*\{\s*toolName/,
    ]);
  });

  it("keeps Durable Execution free of persistence, hosting, and chat projection", () => {
    expectNoMatches(productionSource("durable-execution"), [
      /from ["']@sweatpants\/(?:journal-authority|history-store|agent-host|chat-core|execution-store-redis)/,
      /from ["'](?:node:http|redis|react)["']/,
    ]);
  });

  it("keeps concrete Zod ownership explicit", () => {
    const packageDirs = readdirSync(resolve(root, "packages"));
    for (const packageName of packageDirs) {
      if (!existsSync(resolve(root, "packages", packageName, "src"))) continue;
      const source = productionSource(packageName);
      if (!/import\s+(?!type\b)[^;\n]*from [\"']zod[\"']/.test(source)) {
        continue;
      }
      const packageJson = JSON.parse(
        readFileSync(resolve(root, "packages", packageName, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      expect(packageJson.dependencies?.["zod"], packageName).toBeDefined();
    }
    expect(productionSource("foundation")).not.toMatch(
      /import\s+(?!type\b)[^;\n]*from [\"']zod[\"']/,
    );
  });

  it("keeps Tool Session sampling messages under one canonical owner", () => {
    const declarations: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = resolve(directory, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== "dist" && entry !== "node_modules") visit(path);
        } else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
          const source = readFileSync(path, "utf8");
          if (/export type ExtendedMessage\b/.test(source)) {
            declarations.push(path.replace(`${root}/`, ""));
          }
          expect(source, path).not.toMatch(
            /function (?:providerMessageToModelMessage|extendedToProviderMessage)\b/,
          );
        }
      }
    };
    visit(resolve(root, "packages"));
    visit(resolve(root, "apps"));
    expect(declarations).toEqual(["packages/tool-session/src/messages.ts"]);
    expect(
      existsSync(
        resolve(root, "packages/durable-chat-runtime/src/tool-session/message-conversion.ts"),
      ),
    ).toBe(false);
  });

  it("keeps authored sampling contracts under Agent SDK ownership", () => {
    const owned = [
      "ToolSampleConfig",
      "SampleToolsConfig",
      "SampleSchemaConfig",
      "SampleResultBase",
      "SampleResultWithParsed",
      "SampleResultWithToolCalls",
      "SampleToolsResult",
      "SampleSchemaResult",
    ];
    const declarations = new Map(owned.map((name) => [name, [] as string[]]));
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = resolve(directory, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== "dist" && entry !== "node_modules") visit(path);
          continue;
        }
        if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
        const source = readFileSync(path, "utf8");
        for (const name of owned) {
          if (new RegExp(`export (?:interface|type) ${name}\\b`).test(source)) {
            declarations.get(name)?.push(path.replace(`${root}/`, ""));
          }
        }
        expect(source, path).not.toMatch(/function toWorker(?:Sample|Tools|Schema)Config\b/);
      }
    };
    visit(resolve(root, "packages"));
    visit(resolve(root, "apps"));
    for (const name of owned) {
      expect(declarations.get(name), name).toEqual(["packages/agent-sdk/src/tool/types.ts"]);
    }
    expect(productionSource("tool-runtime-local")).not.toMatch(
      /export (?:interface|type) WorkerSample(?:Config|Result)/,
    );
  });

  it("keeps chat state behavior outside-in and AG-UI conformance simulator-backed", () => {
    const removedInternalSuites = [
      "packages/chat-core/src/smoke.test.ts",
      "packages/chat-core/src/session/__tests__/ag-ui-stream.test.ts",
      "packages/chat-core/src/session/__tests__/history-sync.test.ts",
      "packages/chat-core/src/session/__tests__/message-identity.test.ts",
      "packages/chat-core/src/session/__tests__/turn-state.test.ts",
      "packages/chat-core/src/state/__tests__/ag-ui-fold.test.ts",
      "packages/chat-core/src/state/__tests__/ag-ui-fold-scenarios.test.ts",
      "packages/durable-chat-runtime/src/durable-handler/__tests__/ag-ui-conformance.test.ts",
      "packages/durable-chat-runtime/src/durable-handler/__tests__/history-policy-integration.test.ts",
      "packages/durable-chat-runtime/src/handler/__tests__/pull-stream-handler.test.ts",
      "packages/durable-chat-runtime/src/response-streams/__tests__/durable-streams.test.ts",
      "packages/durable-chat-runtime/src/response-streams/__tests__/effection-webstream-bridge.test.ts",
      "packages/durable-chat-runtime/src/response-streams/__tests__/hello-chat-scenario.test.ts",
      "packages/react-chat/src/__tests__/mcp-plugin-executor.test.ts",
      "packages/react-chat/src/__tests__/plugin-handle-api.test.ts",
    ];
    for (const file of removedInternalSuites) {
      expect(existsSync(resolve(root, file)), file).toBe(false);
    }
    const durableTests = sourceTree(resolve(root, "packages/durable-chat-runtime/src"));
    expect(durableTests).not.toMatch(
      /createMockProvider|setupMockModelProvider|createMockTool|agUiEventSchemas/,
    );
    expect(readFileSync(resolve(root, "packages/test-rig/src/ag-ui.ts"), "utf8")).toMatch(
      /function createAgUiProbe/,
    );
    expect(
      readFileSync(
        resolve(root, "packages/react-chat/acceptance/hook-state.acceptance.test.ts"),
        "utf8",
      ),
    ).toMatch(/s\.agui\.assertConformant/);
  });

  it("keeps authored service and repository ports Effection-native", () => {
    const contractFiles = [
      "packages/durable-execution/src/program-driver-contract.ts",
      "packages/journal-authority/src/durable-authority-types.ts",
      "packages/journal-authority/src/store.ts",
      "packages/history-store/src/contract.ts",
      "packages/tool-session/src/contract.ts",
      "packages/tool-session/src/mcp/durable-invocation.ts",
      "packages/workspace-runtime/src/sandbox-substrate.ts",
      "packages/agent-host/src/server/agent-connections.ts",
    ];
    for (const file of contractFiles) {
      expect(readFileSync(resolve(root, file), "utf8"), file).not.toMatch(/Promise</);
    }
    const invocation = readFileSync(
      resolve(root, "packages/tool-session/src/mcp/durable-invocation.ts"),
      "utf8",
    );
    expect(invocation).toMatch(/createOrReturn\([\s\S]*?Operation<IdempotencyCreateResult<T>>/);
  });
});
