import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const appEnv = createEnv({
  server: {
    // Canonical default chat model identity. Requests may override this with
    // nested { model: { provider, id } } when allowed by server policy.
    DEFAULT_CHAT_MODEL_PROVIDER: z.string().min(1),
    DEFAULT_CHAT_MODEL_ID: z.string().min(1),

    // Optional structured allow-list. When unset, only the configured default
    // model is allowed unless UNSAFE_ALLOW_ANY_CHAT_MODEL=yes.
    ALLOWED_CHAT_MODELS_JSON: z
      .string()
      .optional()
      .refine((value) => {
        if (value === undefined) {
          return true;
        }
        try {
          const parsed = JSON.parse(value);
          return (
            Array.isArray(parsed) &&
            parsed.every(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                !Array.isArray(entry) &&
                typeof (entry as { provider?: unknown }).provider === "string" &&
                (entry as { provider: string }).provider.trim().length > 0 &&
                typeof (entry as { id?: unknown }).id === "string" &&
                (entry as { id: string }).id.trim().length > 0,
            )
          );
        } catch {
          return false;
        }
      }, "ALLOWED_CHAT_MODELS_JSON must be a JSON array of { provider, id } objects"),
    UNSAFE_ALLOW_ANY_CHAT_MODEL: z.string().optional(),

    // Provider option configuration. These do not select model identity.
    OLLAMA_URL: z.string().default("http://localhost:11434"),
    OLLAMA_BASE_URL: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
    AWS_REGION: z.string().optional(),

    // Test-only deterministic model provider for rendering pipeline e2e fixtures.
    // Production/shared servers MUST leave this unset.
    ENABLE_SCRIPTED_RENDERING_PROVIDER: z.enum(["yes"]).optional(),

    // Default system prompt for manual chat mode. Individual requests/personas may override it.
    CHAT_SYSTEM_PROMPT: z
      .string()
      .default(
        `You are yo-chat, a tool-using assistant. Use the available tools whenever the user asks you to use a tool, book a flight, calculate something, pick a card, or play a game. When the user says not to answer directly, you must call the appropriate tool instead of explaining. Use the provider's native tool-calling mechanism; do not print tool-call JSON as text. After a tool returns a result, treat that result as authoritative. If the result completes the user's request, confirms success, or includes a ticket/confirmation/reservation, do not call the same tool again for that request; summarize the completed result to the user.`,
      ),

    // Max tool call iterations
    MAX_TOOL_ITERATIONS: z.coerce.number().default(10),

    // Redis configuration (optional, falls back to in-memory if not set)
    REDIS_URL: z.string().optional(),

    // ProgramRuntime journal signing secret. Startup fails when it is absent.
    PROGRAM_DRIVER_CAPABILITY_SECRET: z.string().min(32).optional(),

    // MCP plugin tool execution mode.
    // - local: current yo-chat behavior; tool generators run in local worker/session runtime.
    // - agentcore: local chat/UI with tool generators running in AWS Bedrock AgentCore Runtime.
    MCP_TOOL_RUNTIME: z.enum(["local", "agentcore"]).default("local"),

    // AgentCore Runtime configuration used when MCP_TOOL_RUNTIME=agentcore.
    AGENTCORE_RUNTIME_ARN: z.string().optional(),
    AGENTCORE_REGION: z
      .string()
      .default(process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1"),
    AGENTCORE_ENDPOINT_NAME: z.string().default("DEFAULT"),
    AGENTCORE_RUNTIME_PROFILE_NAME: z.string().default("yo-chat-agentcore"),
    // Explicit immutable durable evaluator release. These do not fall back to DEFAULT.
    AGENTCORE_DURABLE_RELEASE_ID: z.string().optional(),
    AGENTCORE_DURABLE_IMAGE_DIGEST: z.string().optional(),
    AGENTCORE_DURABLE_REGISTRY_DIGEST: z.string().optional(),
    AGENTCORE_DURABLE_IAM_PROFILE: z.string().optional(),
    AGENTCORE_DURABLE_NETWORK_PROFILE: z.string().optional(),
    AGENTCORE_DURABLE_IDLE_TIMEOUT_SECONDS: z.coerce.number().default(180),
    AGENTCORE_DURABLE_MAX_LIFETIME_SECONDS: z.coerce.number().default(28_800),
    AGENTCORE_TOOL_SESSION_TTL_MS: z.coerce.number().default(15 * 60 * 1000),
    AGENTCORE_REDIS_KEY_PREFIX: z.string().default("sp:yo-chat:agentcore:"),
  },

  /**
   * Prefix that client-side variables must have. Enforced by @t3-oss/env-core.
   */
  clientPrefix: "VITE_",

  client: {
    // Example public env var (expand as needed)
    VITE_BASE_URL: z.string().optional(),
    // Test-only UI gate for deterministic rendering e2e fixtures.
    VITE_ENABLE_SCRIPTED_RENDERING: z.enum(["1"]).optional(),
  },

  /**
   * On the server we validate against process.env.
   */
  runtimeEnv: process.env,

  emptyStringAsUndefined: true,
});

// createEnv returns a flat, readonly env object with all keys from
// both server and client merged. We infer that flat type here.
export type AppEnv = typeof appEnv;
