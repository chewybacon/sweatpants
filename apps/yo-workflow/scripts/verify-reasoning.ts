import { run } from "effection";
import { FileCredentialStore, createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { createTisynModels } from "../src/server/cloudflare/model-catalog.ts";
import { modelOptions } from "./model-options.ts";

// Real requests through the same canonical adapter used by the app. Never log
// full payloads: they can contain conversation content or provider metadata.
const selection = modelOptions(process.argv.slice(2));
if (selection.help) {
  console.log(
    "Usage: pnpm verify:reasoning [--provider opencode|github-copilot] [--model ID]\nMakes three real requests at low, medium, and high and verifies outgoing effort fields.",
  );
  process.exit(0);
}
if (selection.listModels || selection.astroArgs.length > 0) {
  throw new Error(
    "Use dev:cloudflare --list-models to list models; this probe accepts --provider and --model.",
  );
}
const models = createTisynModels(new FileCredentialStore());
const provider = createPiAiModelProvider({ models });
const model = provider.resolveModel({ provider: selection.provider, id: selection.model });
for (const thinking of ["low", "medium", "high"] as const) {
  let wire:
    | {
        thinking?: unknown;
        output_config?: unknown;
        reasoning?: unknown;
        reasoning_effort?: unknown;
      }
    | undefined;
  const response = await run(function* () {
    const stream = yield* provider.runtime.stream(
      model,
      {
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with just OK." }] }],
        tools: [],
      },
      {
        thinking,
        maxTokens: 1024,
        signal: AbortSignal.timeout(120_000),
        onPayload(payload) {
          const fields = payload as NonNullable<typeof wire>;
          wire = {
            thinking: fields.thinking,
            output_config: fields.output_config,
            reasoning: fields.reasoning,
            reasoning_effort: fields.reasoning_effort,
          };
        },
      },
    );
    while (true) {
      const next = yield* stream.next();
      if (next.done) {
        return next.value;
      }
    }
  });
  const effort =
    (wire?.output_config as { effort?: string } | undefined)?.effort ??
    (wire?.reasoning as { effort?: string } | undefined)?.effort ??
    wire?.reasoning_effort;
  console.log(
    JSON.stringify({
      provider: selection.provider,
      model: selection.model,
      requested: thinking,
      wire,
      stopReason: response.stopReason,
      usage: response.usage,
      text: response.message.content.filter((part) => part.type === "text"),
      error: response.errorMessage,
    }),
  );
  if (effort !== thinking || response.errorMessage || response.stopReason !== "stop") {
    throw new Error(
      `Reasoning verification failed for ${thinking}; inspect the safe fields above.`,
    );
  }
}
