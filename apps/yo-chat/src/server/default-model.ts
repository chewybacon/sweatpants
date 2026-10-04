import {
  defaultModelForProvider,
  isYoChatAuthProvider,
  readStoredModelSelection,
} from "@sweatpants/model-provider-pi-ai";
import type { ModelSelection } from "@sweatpants/model-provider-pi-ai";

/**
 * Server-only default model resolution. Explicit process environment wins for
 * CI and one-off runs; otherwise yo-chat uses the model selected by
 * `pnpm model:auth:use`.
 */
export function defaultYoChatModel(): ModelSelection {
  const stored = readStoredModelSelection();
  const provider =
    process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? stored?.provider ?? "github-copilot";
  const id =
    process.env["DEFAULT_CHAT_MODEL_ID"] ??
    (stored?.provider === provider ? stored.id : undefined) ??
    (isYoChatAuthProvider(provider) ? defaultModelForProvider(provider) : "claude-sonnet-4.6");
  return { provider, id };
}
