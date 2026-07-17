import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env["CI"]);
const reuseExistingServer = process.env["PLAYWRIGHT_REUSE_EXISTING_SERVER"] === "1" && !isCI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: isCI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:5001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command:
        "YO_A2A_PORT=45679 YO_A2A_MODEL_MODE=scripted YO_A2A_BEARER_TOKEN=inspector-bearer-secret YO_A2A_EVIDENCE_TOKEN=inspector-evidence-secret pnpm dev",
      port: 45679,
      reuseExistingServer,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "../../interop/a2a-inspector/launch-inspector.sh",
      url: "http://127.0.0.1:5001",
      reuseExistingServer,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
