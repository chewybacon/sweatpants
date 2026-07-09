import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(appRoot, relativePath), "utf8");
}

function listFiles(dir: string): string[] {
  const root = resolve(appRoot, dir);
  return readdirSync(root).flatMap((entry) => {
    const full = resolve(root, entry);
    const rel = `${dir}/${entry}`;
    return statSync(full).isDirectory() ? listFiles(rel) : [rel];
  });
}

describe("yo-chat chat application composition", () => {
  it("keeps the api.chat route as thin route glue", () => {
    const route = read("src/routes/api.chat.ts");

    expect(route).toContain("from '../server/chat-application'");
    expect(route).toContain("chatApp.handle(request)");
    expect(route).toContain("withDefaultSystemPrompt(request)");
    expect(route.split("\n").length).toBeLessThanOrEqual(30);

    for (const forbidden of [
      "@sweatpants/model-provider-pi-ai",
      "@sweatpants/tool-runtime-local",
      "@sweatpants/tool-runtime-agentcore",
      "@sweatpants/framework/chat/durable-streams",
      "createToolInventory",
      "installAgentCoreToolRuntime",
      "installLocalToolRuntime",
      "createPluginSessionManager",
    ]) {
      expect(route).not.toContain(forbidden);
    }
  });

  it("uses structured model configuration without the removed provider split", () => {
    const envSchema = read("src/env.schema.ts");
    const modelProvider = read("src/server/model-provider.ts");

    expect(envSchema).toContain("DEFAULT_CHAT_MODEL_PROVIDER");
    expect(envSchema).toContain("DEFAULT_CHAT_MODEL_ID");
    expect(envSchema).toContain("ALLOWED_CHAT_MODELS_JSON");
    expect(modelProvider).toContain("parseRequestModelSelection");
    expect(modelProvider).toContain("resolveModelSelection");
    expect(modelProvider).toContain("resolvePiAiModel");

    const removedProviderEnv = ["CHAT", "PROVIDER"].join("_");
    const removedOllamaEnv = ["OLLAMA", "MODEL"].join("_");
    const removedOpenAiEnv = ["OPENAI", "MODEL"].join("_");
    const removedResolver = ["resolve", "Runtime", "Model"].join("");
    for (const removed of [
      removedProviderEnv,
      removedOllamaEnv,
      removedOpenAiEnv,
      removedResolver,
    ]) {
      expect(envSchema).not.toContain(removed);
      expect(modelProvider).not.toContain(removed);
    }
  });

  it("keeps scripted rendering fixtures behind explicit Playwright-only gates", () => {
    const envSchema = read("src/env.schema.ts");
    const modelProvider = read("src/server/model-provider.ts");
    const basicRoute = read("src/routes/chat/basic/index.tsx");
    const playwrightConfig = read("playwright.config.ts");

    expect(envSchema).toContain("ENABLE_SCRIPTED_RENDERING_PROVIDER");
    expect(envSchema).toContain("VITE_ENABLE_SCRIPTED_RENDERING");
    expect(modelProvider).toContain("env.ENABLE_SCRIPTED_RENDERING_PROVIDER !== 'yes'");
    expect(modelProvider).toContain("Scripted rendering provider is disabled");
    expect(modelProvider).toContain("installScriptedRenderingModelProvider");
    expect(basicRoute).toContain("import.meta.env['VITE_ENABLE_SCRIPTED_RENDERING'] === '1'");
    expect(playwrightConfig).toContain("ENABLE_SCRIPTED_RENDERING_PROVIDER");
    expect(playwrightConfig).toContain("VITE_ENABLE_SCRIPTED_RENDERING");
    expect(playwrightConfig).toContain("E2E_FULL");
    expect(playwrightConfig).toContain("deterministicBrowserSmokeSpecs");
    expect(playwrightConfig).toContain('globalSetup: "./e2e/global-setup.ts"');
  });

  it("keeps production chat wiring in app-owned server modules", () => {
    const serverFiles = listFiles("src/server");
    expect(serverFiles).toContain("src/server/chat-application.ts");

    expect(serverFiles).toEqual(
      expect.arrayContaining([
        "src/server/default-system-prompt.ts",
        "src/server/durable-streams.ts",
        "src/server/model-provider.ts",
        "src/server/plugin-sampling-provider.ts",
        "src/server/tool-runtime.ts",
        "src/server/tools.ts",
      ]),
    );

    const composition = read("src/server/chat-application.ts");
    expect(composition).toContain("createYoChatApplication");
    expect(composition).toContain("createChatApplication");
    expect(composition).toContain("createChatHandler");
    expect(composition.split("\n").length).toBeLessThanOrEqual(60);

    const serverSources = serverFiles.map((file) => read(file)).join("\n");
    expect(serverSources).toContain("installPiAiModelProvider");
    expect(serverSources).toContain("installLocalToolRuntime");
    expect(serverSources).toContain("createAgentCoreToolExecutionStrategy");
    expect(serverSources).toContain("withDefaultSystemPrompt");
  });
});
