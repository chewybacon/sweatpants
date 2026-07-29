import { readFileSync, readdirSync, statSync } from "node:fs";
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

  it("keeps Chat Core free of hosting, authority persistence, Redis, and MCP handlers", () => {
    expectNoMatches(productionSource("chat-core"), [
      /from ["']@sweatpants\/(?:agent-host|journal-authority|execution-store-redis)/,
      /@sweatpants\/tool-session\/mcp\/handler/,
      /from ["'](?:node:http|redis)["']/,
    ]);
  });

  it("keeps Durable Execution free of persistence, hosting, and chat projection", () => {
    expectNoMatches(productionSource("durable-execution"), [
      /from ["']@sweatpants\/(?:journal-authority|history-store|agent-host|chat-core|execution-store-redis)/,
      /from ["'](?:node:http|redis|react)["']/,
    ]);
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
