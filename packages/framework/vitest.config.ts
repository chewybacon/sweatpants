import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: [],
    // Exclude e2e tests - they have their own config and require a running server
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
})