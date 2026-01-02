/**
 * Global setup for E2E tests
 * 
 * This file is run once before all tests.
 * Configure interactors and other global settings here.
 */
import { setDocumentResolver, setInteractorTimeout } from '@interactors/html'
import { e2eConfig } from './config'

// Configure Interactors to use the jsdom document
setDocumentResolver(() => document)

// Set a longer timeout for interactors (LLM responses can be slow)
setInteractorTimeout(e2eConfig.interactorTimeout)

// Log configuration for debugging
if (process.env['E2E_DEBUG']) {
  console.log('[e2e] Configuration:', {
    backendUrl: e2eConfig.backendUrl,
    serverPort: e2eConfig.serverPort,
    llmResponseTimeout: e2eConfig.llmResponseTimeout,
    interactorTimeout: e2eConfig.interactorTimeout,
    retries: e2eConfig.retries,
    defaultModel: e2eConfig.defaultModel,
    provider: e2eConfig.provider,
  })
}
