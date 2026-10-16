import { fileURLToPath } from "node:url";
import { run } from "effection";
import { FileCredentialStore, createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { createTisynModels } from "../../../apps/yo-workflow/src/server/cloudflare/model-catalog.ts";
const provider = createPiAiModelProvider({
  models: createTisynModels(
    new FileCredentialStore(
      fileURLToPath(new URL("../../../.sweatpants/auth.json", import.meta.url)),
    ),
  ),
});
const model = provider.resolveModel({ provider: "opencode", id: "claude-haiku-5-5" });
export async function author(prompt: string) {
  const started = performance.now();
  let effort: unknown;
  const response = await run(function* () {
    const stream = yield* provider.runtime.stream(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [] },
      {
        thinking: "medium",
        maxTokens: 12000,
        signal: AbortSignal.timeout(120000),
        onPayload(payload) {
          effort = (payload as { output_config?: { effort?: string } }).output_config?.effort;
        },
      },
    );
    while (true) {
      const next = yield* stream.next();
      if (next.done) return next.value;
    }
  });

  if (effort !== "medium")
    throw new Error(`Expected medium reasoning wire field, received ${String(effort)}`);
  const raw = response.message.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const source = raw
    .trim()
    .replace(/^```[^\n]*\n/, "")
    .replace(/\n```$/, "")
    .trim();
  return {
    source,
    raw,
    stopReason: response.stopReason,
    generationError:
      response.errorMessage ||
      (response.stopReason !== "stop" ? `Generation stopped: ${response.stopReason}` : undefined),
    usage: response.usage,
    milliseconds: Math.round(performance.now() - started),
    effort,
  };
}
