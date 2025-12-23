import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const appEnv = createEnv({
  server: {
    // Chat provider selection
    CHAT_PROVIDER: z.enum(['ollama', 'openai']).default('ollama'),

    // Ollama configuration
    OLLAMA_URL: z.string().default('http://localhost:11434'),
    OLLAMA_MODEL: z.string().default('qwen3:30b'),
    //OLLAMA_MODEL: z.string().default('deepseek-r1:70b'),

    // OpenAI configuration (required when CHAT_PROVIDER=openai)
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-5.2'),
    OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),

    // Max tool call iterations
    MAX_TOOL_ITERATIONS: z.coerce.number().default(10),
  },

  /**
   * Prefix that client-side variables must have. Enforced by @t3-oss/env-core.
   */
  clientPrefix: 'VITE_',

  client: {
    // Example public env var (expand as needed)
    VITE_BASE_URL: z.string().optional(),
  },

  /**
   * On the server we validate against process.env.
   */
  runtimeEnv: process.env,

  emptyStringAsUndefined: true,
})

// createEnv returns a flat, readonly env object with all keys from
// both server and client merged. We infer that flat type here.
export type AppEnv = typeof appEnv
