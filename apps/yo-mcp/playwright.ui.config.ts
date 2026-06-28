import { defineConfig } from '@playwright/test'
import baseConfig from './playwright.config'

// UI-mode config: run against already-started yo-mcp + MCP Inspector servers.
// This avoids Playwright UI mode getting stuck while trying to manage webServer
// lifecycle for long-lived interactive sessions.
export default defineConfig({
  ...baseConfig,
  webServer: undefined,
})
