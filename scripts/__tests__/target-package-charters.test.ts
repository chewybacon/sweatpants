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
