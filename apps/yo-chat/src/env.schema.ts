import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const appEnv = createEnv({
  server: {
    // Chat provider selection (defaults to 'ollama' for local development)
    CHAT_PROVIDER: z.enum(['ollama', 'openai']).default('ollama'),

    // Ollama configuration
    OLLAMA_URL: z.string().default('http://localhost:11434'),
    OLLAMA_MODEL: z.string().default('qwen3:30b'),
    //OLLAMA_MODEL: z.string().default('deepseek-r1:70b'),

    // OpenAI configuration (required when CHAT_PROVIDER=openai)
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-5-chat-latest'),
    OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),

    // Max tool call iterations
    MAX_TOOL_ITERATIONS: z.coerce.number().default(10),

    // Redis configuration (optional, falls back to in-memory if not set)
    REDIS_URL: z.string().optional(),

    // MCP plugin tool execution mode.
    // - local: current yo-chat behavior; tool generators run in local worker/session runtime.
    // - agentcore: local chat/UI with tool generators running in AWS Bedrock AgentCore Runtime.
    MCP_TOOL_RUNTIME: z.enum(['local', 'agentcore']).default('local'),

    // AgentCore Runtime configuration used when MCP_TOOL_RUNTIME=agentcore.
    AGENTCORE_RUNTIME_ARN: z.string().optional(),
    AGENTCORE_REGION: z.string().default(process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1'),
    AGENTCORE_ENDPOINT_NAME: z.string().default('DEFAULT'),
    AGENTCORE_RUNTIME_PROFILE_NAME: z.string().default('yo-chat-agentcore'),
    // Optional override/allowlist. When unset, yo-chat uses the generated
    // AgentCore registry artifact as the source of truth for shipped tools.
    AGENTCORE_TOOL_NAMES: z.string().optional(),
    AGENTCORE_TOOL_SESSION_TTL_MS: z.coerce.number().default(15 * 60 * 1000),
    AGENTCORE_REDIS_KEY_PREFIX: z.string().default('sp:yo-chat:agentcore:'),
    // Local/development safety gate for paid app-mode AgentCore invocation.
    APPROVE_AGENTCORE_PAID_INVOCATION: z.string().optional(),
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
