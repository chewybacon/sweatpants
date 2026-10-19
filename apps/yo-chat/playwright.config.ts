import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
if (process.env["SWEATPANTS_STORAGE"] === "memory") {
  throw new Error("Playwright E2E requires the default SQLite authority store");
}
const playwrightStorageRoot = mkdtempSync(join(tmpdir(), "yo-chat-e2e-"));
const playwrightDatabasePath = join(playwrightStorageRoot, "yo-chat.sqlite");
process.env["SWEATPANTS_DB_PATH"] = playwrightDatabasePath;

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
  /* CONDITIONAL-SPREAD: Choose mutually exclusive globalSetup, testMatch fields for runFullE2E; both branches cannot be present. */
  ...(runFullE2E
    ? { globalSetup: "./e2e/global-setup.ts" }
    : { testMatch: deterministicBrowserSmokeSpecs }),
  globalTeardown: "./e2e/global-teardown.ts",
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
    // Landing disables retries; retain the first failure's evidence too.
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm exec tsx ../../scripts/dev-app.ts yo-chat vite dev --port ${playwrightPort} --strictPort --force`,
    url: playwrightBaseUrl,
    reuseExistingServer,
    timeout: 120000,
    env: {
      ...process.env,
      MCP_TOOL_RUNTIME: process.env["MCP_TOOL_RUNTIME"] ?? "local",
      PROGRAM_DRIVER_CAPABILITY_SECRET:
        process.env["PROGRAM_DRIVER_CAPABILITY_SECRET"] ??
        "yo-chat-playwright-capability-secret-at-least-32-bytes",
      SWEATPANTS_DB_PATH: playwrightDatabasePath,
      PLAYWRIGHT_TEST_SERVER: "1",
      VITE_PLAYWRIGHT_TEST_SERVER: "1",
    },
  },
});
