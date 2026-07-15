import { defineConfig, devices } from "@playwright/test";

const isCI = process.env["CI"];
const reuseExistingServer = process.env["PLAYWRIGHT_REUSE_EXISTING_SERVER"] === "1" && !isCI;
// Keep deterministic Playwright isolated from the normal developer server on
// port 8000. Override when needed, e.g. PLAYWRIGHT_PORT=8123.
const playwrightPort = Number(process.env["PLAYWRIGHT_PORT"] ?? "8010");
if (!Number.isSafeInteger(playwrightPort) || playwrightPort < 1 || playwrightPort > 65_535) {
  throw new Error("PLAYWRIGHT_PORT must be a valid TCP port");
}
const playwrightBaseUrl = `http://localhost:${playwrightPort}`;

// G7 (outside-in HTTP test tier): worker-exercising / live-model outcome
// coverage lives in the headless outside-in tier (`pnpm test:outside-in`, see
// src/outside-in/). Playwright's default job is a THIN deterministic browser /
// rendering smoke layer, so only non-live specs run unless E2E_FULL=1.
const runFullE2E = process.env["E2E_FULL"] === "1";
const deterministicBrowserSmokeSpecs = [
  "**/deterministic-elicit-rendering.spec.ts",
  "**/interactors-playwright.spec.ts",
  "**/journal-inspector.spec.ts",
  "**/rendering-pipeline.spec.ts",
];

export default defineConfig({
  testDir: "./e2e",
  ...(runFullE2E ? {} : { testMatch: deterministicBrowserSmokeSpecs }),
  ...(runFullE2E ? { globalSetup: "./e2e/global-setup.ts" } : {}),
  fullyParallel: true,
  forbidOnly: !!isCI,
  retries: isCI ? 2 : 0,
  // Live-model tests share one provider/server process; keep them serial to
  // avoid provider-side throttling or transient network errors.
  workers: 1,
  reporter: "html",
  use: {
    baseURL: playwrightBaseUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm exec vite dev --port ${playwrightPort}`,
    url: playwrightBaseUrl,
    reuseExistingServer,
    timeout: 120000,
    env: {
      ...process.env,
      DEFAULT_CHAT_MODEL_PROVIDER: process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "github-copilot",
      DEFAULT_CHAT_MODEL_ID: process.env["DEFAULT_CHAT_MODEL_ID"] ?? "claude-sonnet-4.5",
      OLLAMA_URL: process.env["OLLAMA_URL"] ?? "http://localhost:11434",
      MCP_TOOL_RUNTIME: process.env["MCP_TOOL_RUNTIME"] ?? "local",
      PLAYWRIGHT_TEST_SERVER: "1",
      ENABLE_SCRIPTED_RENDERING_PROVIDER: "yes",
      VITE_ENABLE_SCRIPTED_RENDERING: "1",
    },
  },
});
