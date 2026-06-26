import { defineConfig, devices } from '@playwright/test'

const isCI = process.env['CI']
const reuseExistingServer = process.env['PLAYWRIGHT_REUSE_EXISTING_SERVER'] === '1' && !isCI

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!isCI,
  retries: isCI ? 2 : 0,
  // Live-model tests share one provider/server process; keep them serial to
  // avoid provider-side throttling or transient network errors.
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:8000',
    reuseExistingServer,
    timeout: 120000,
    env: {
      ...process.env,
      DEFAULT_CHAT_MODEL_PROVIDER: process.env['DEFAULT_CHAT_MODEL_PROVIDER'] ?? 'github-copilot',
      DEFAULT_CHAT_MODEL_ID: process.env['DEFAULT_CHAT_MODEL_ID'] ?? 'claude-sonnet-4.5',
      OLLAMA_URL: process.env['OLLAMA_URL'] ?? 'http://localhost:11434',
      MCP_TOOL_RUNTIME: process.env['MCP_TOOL_RUNTIME'] ?? 'local',
    },
  },
})
