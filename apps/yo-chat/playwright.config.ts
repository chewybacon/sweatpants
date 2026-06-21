import { defineConfig, devices } from '@playwright/test'

const isCI = process.env['CI']

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!isCI,
  retries: isCI ? 2 : 0,
  // Local live-model tests share one Ollama/server process; parallel prompts can
  // overload the provider and surface as transient network errors.
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
    reuseExistingServer: !isCI,
    timeout: 120000,
  },
})
