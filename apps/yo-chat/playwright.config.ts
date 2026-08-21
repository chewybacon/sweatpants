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

// Playwright is an optional presentation/browser gate:
// - default: deterministic browser smoke tests when explicitly invoked
// - E2E_FULL=1: extensive, manually-invoked live suite using the selected
//   managed provider.
//
// The manual suite retains threaded-chat, pick-card, play_ttt, tictactoe,
// book-flight, and durable-chat coverage without provider-specific variants.
const runFullE2E = process.env["E2E_FULL"] === "1";
const deterministicBrowserSmokeSpecs = [
  "**/deterministic-elicit-rendering.spec.ts",
  "**/journal-inspector.spec.ts",
];

export default defineConfig({
  testDir: "./e2e",
  ...(runFullE2E
    ? { globalSetup: "./e2e/global-setup.ts" }
    : { testMatch: deterministicBrowserSmokeSpecs }),
  fullyParallel: true,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!isCI,
  retries: isCI ? 2 : 0,
  // Live-model tests share one provider/server process; keep them serial to
  // avoid provider-side throttling or transient network errors.
  workers: 1,
  reporter: "html",
  use: {
    baseURL: playwrightBaseUrl,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
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
      MCP_TOOL_RUNTIME: process.env["MCP_TOOL_RUNTIME"] ?? "local",
      PLAYWRIGHT_TEST_SERVER: "1",
      VITE_PLAYWRIGHT_TEST_SERVER: "1",
    },
  },
});
