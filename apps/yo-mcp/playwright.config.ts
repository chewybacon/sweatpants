import { defineConfig, devices } from '@playwright/test'

const isCI = process.env['CI']

/**
 * Playwright config for yo-mcp E2E tests.
 * 
 * These tests drive the MCP Inspector UI to test tool flows:
 * - echo (simple, no backchannel)
 * - greet (sampling)
 * - pick_card (elicitation)
 * - confirm (elicitation)
 * - pick_card_branch (complex branching)
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Tools tests need sequential execution
  forbidOnly: !!isCI,
  retries: isCI ? 2 : 0,
  workers: 1, // Single worker to avoid port conflicts
  reporter: isCI ? 'github' : 'html',
  timeout: 60000, // 60s per test (tools can be slow)
  
  use: {
    // MCP Inspector runs on port 6274
    baseURL: 'http://localhost:6274',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start both yo-mcp server and MCP Inspector
  webServer: [
    {
      // Start yo-mcp HTTP server
      command: 'pnpm dev',
      port: 3001, // Wait for this port to be listening
      reuseExistingServer: false, // Always start fresh
      timeout: 30000,
      stdout: 'pipe', // Show server output
    },
    {
      // Start MCP Inspector (connects to yo-mcp)
      // DANGEROUSLY_OMIT_AUTH=true disables proxy auth for testing
      // MCP_AUTO_OPEN_ENABLED=false prevents auto-opening the browser
      command: 'DANGEROUSLY_OMIT_AUTH=true MCP_AUTO_OPEN_ENABLED=false npx @modelcontextprotocol/inspector --transport http --server-url http://localhost:3001/mcp',
      port: 6274, // Inspector UI port
      reuseExistingServer: false, // Always start fresh
      timeout: 30000,
      stdout: 'pipe', // Show inspector output
    },
  ],
})
