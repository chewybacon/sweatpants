/**
 * Vitest configuration for E2E tests
 *
 * These tests:
 * - Run against a real backend server (spawned or existing)
 * - Use jsdom for React component rendering
 * - Have longer timeouts for LLM responses
 * - Support retry for flaky tests
 */
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  // Use esbuild for JSX transformation
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },

  test: {
    // E2E tests are in the tests/ directory (relative to this config file)
    root: __dirname,
    include: ['tests/**/*.test.{ts,tsx}'],

    // Use jsdom for React testing with Interactors
    environment: 'jsdom',

    // Longer timeout for LLM responses (3 minutes per test)
    testTimeout: 180000,

    // Hook timeout for server startup
    hookTimeout: 120000,

    // Retry flaky tests (configurable via E2E_RETRIES env var)
    retry: parseInt(process.env['E2E_RETRIES'] ?? '1', 10),

    // Run tests sequentially to avoid port conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // Setup file for global configuration
    setupFiles: [path.resolve(__dirname, 'setup/global-setup.ts')],

    // Exclude from main test runs (run separately via pnpm test:e2e)
    // This config is used when running vitest from the e2e directory
  },

  resolve: {
    alias: {
      // Resolve framework imports to source
      '@sweatpants/framework': path.resolve(__dirname, '../src'),
    },
  },
})
