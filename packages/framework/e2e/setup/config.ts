/**
 * E2E Test Configuration
 * 
 * Configurable settings for E2E tests that hit a real backend.
 */

export interface E2EConfig {
  /** Backend server URL */
  backendUrl: string
  
  /** Port for the test server */
  serverPort: number
  
  /** Timeout for server startup (ms) */
  serverStartTimeout: number
  
  /** Timeout for LLM responses (ms) */
  llmResponseTimeout: number
  
  /** Timeout for Interactor operations (ms) */
  interactorTimeout: number
  
  /** Number of retries for flaky tests */
  retries: number
  
  /** Default LLM model to use */
  defaultModel: string
  
  /** LLM provider (ollama, openai) */
  provider: 'ollama' | 'openai'
  
  /** Use deterministic prompts that guide LLM behavior */
  useDeterministicPrompts: boolean
  
  /** Chat API endpoint path (e.g., '/api/chat' or '/api/chat-durable') */
  chatEndpoint: string
}

/**
 * Default configuration - can be overridden via environment variables
 */
export const e2eConfig: E2EConfig = {
  backendUrl: process.env['E2E_BACKEND_URL'] ?? 'http://localhost:8765',
  serverPort: parseInt(process.env['E2E_SERVER_PORT'] ?? '8765', 10),
  serverStartTimeout: parseInt(process.env['E2E_SERVER_TIMEOUT'] ?? '60000', 10),
  llmResponseTimeout: parseInt(process.env['E2E_LLM_TIMEOUT'] ?? '120000', 10),
  interactorTimeout: parseInt(process.env['E2E_INTERACTOR_TIMEOUT'] ?? '30000', 10),
  retries: parseInt(process.env['E2E_RETRIES'] ?? (process.env['CI'] ? '3' : '1'), 10),
  defaultModel: process.env['E2E_MODEL'] ?? 'llama3.1:latest',
  provider: (process.env['E2E_PROVIDER'] as 'ollama' | 'openai') ?? 'ollama',
  useDeterministicPrompts: process.env['E2E_DETERMINISTIC'] !== 'false',
  // Use durable endpoint if E2E_USE_DURABLE=true, otherwise default /api/chat
  chatEndpoint: process.env['E2E_USE_DURABLE'] === 'true' ? '/api/chat-durable' : '/api/chat',
}

/**
 * Get config with optional overrides
 */
export function getConfig(overrides?: Partial<E2EConfig>): E2EConfig {
  return { ...e2eConfig, ...overrides }
}
