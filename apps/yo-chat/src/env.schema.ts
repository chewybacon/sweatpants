import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const appEnv = createEnv({
  server: {
    // Canonical default chat model identity. Requests may override this with
    // nested { model: { provider, id } } when allowed by server policy.
    DEFAULT_CHAT_MODEL_PROVIDER: z.string().min(1).default("github-copilot"),
    DEFAULT_CHAT_MODEL_ID: z.string().min(1).default("claude-sonnet-4.6"),

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
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
    AWS_REGION: z.string().optional(),

    // Default system prompt for manual chat mode. Individual requests/personas may override it.
    CHAT_SYSTEM_PROMPT: z
      .string()
      .default(
        `You are yo-chat, a tool-using assistant. Use the available tools whenever the user asks you to use a tool, book a flight, calculate something, pick a card, or play a game. When the user says not to answer directly, you must call the appropriate tool instead of explaining. Use the provider's native tool-calling mechanism; do not print tool-call JSON as text. Tool argument rules: pick_card.count is optional, but when provided it must be an integer from 2 through 10; if the user asks to draw a card without specifying a count, omit count or use 2, never 1. After a tool returns a result, treat that result as authoritative. If the result completes the user's request, confirms success, or includes a ticket/confirmation/reservation, do not call the same tool again for that request; summarize the completed result to the user.`,
      ),

    // Max tool call iterations
    MAX_TOOL_ITERATIONS: z.coerce.number().default(10),

    // Authority storage is resolved by chatStorageFromEnv in storage-config.ts:
    // This app requires a persistent SQLite path.

    // The yo-chat demo now uses local Guest placement only.
    MCP_TOOL_RUNTIME: z.literal("local").default("local"),
  },

  /**
   * Prefix that client-side variables must have. Enforced by @t3-oss/env-core.
   */
  clientPrefix: "VITE_",

  client: {
    // Example public env var (expand as needed)
    VITE_BASE_URL: z.string().optional(),
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
