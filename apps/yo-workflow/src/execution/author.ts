import { run } from "effection";
import { FileCredentialStore, createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { createTisynModels } from "../server/cloudflare/model-catalog.ts";
import { reasoningLevel } from "../server/model-settings.ts";

/** Authoring is host work; the generated caller is pinned before execution opens. */
export async function authorCaller(prompt: string): Promise<string> {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
    throw Error("Describe a workflow in 1–4000 characters");
  }
  const provider = createPiAiModelProvider({
    models: createTisynModels(new FileCredentialStore()),
  });
  const model = provider.resolveModel({
    provider: process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "opencode",
    id: process.env["DEFAULT_CHAT_MODEL_ID"] ?? "claude-haiku-5-5",
  });
  const signal = AbortSignal.timeout(180_000);
  for (const maxTokens of [16_384, 32_768]) {
    const response = await run(function* () {
      const stream = yield* provider.runtime.stream(
        model,
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Write a Scheme caller for a durable workflow evaluator. Return only Scheme source, without Markdown.
Available compiled developer function: (review_draft input). input is a JSON object with title (string), recipient (string), metadata (JSON value). It asks the human for approval, registers cleanup that asks the human to release the reservation, and returns the string "Draft approved" or "Draft declined". Call it; do not redefine it or simulate its effects.
The caller must define (workflow input) and end with (workflow %input). %input is provided by the host. Available host tool: (send_announcement input). It queues an announcement in the local outbox and returns a JSON object with announcementId, status, title, recipient. Call it only after review_draft returns "Draft approved". Return its receipt or a string explaining the decline. The host owns execution; do not implement this tool.
Use define, let, let*, if, equal?, json-field, string-append and ordinary function calls. No imports, eval, external APIs, or direct effects. Preserve the tool result. This experiment has no email-sending capability.
User request: ${prompt}`,
                },
              ],
            },
          ],
          tools: [],
        },
        {
          thinking: reasoningLevel(process.env["DEFAULT_CHAT_MODEL_THINKING"]),
          maxTokens,
          signal,
        },
      );
      while (true) {
        const next = yield* stream.next();
        if (next.done) return next.value;
      }
    });
    if (response.stopReason === "length" && !response.errorMessage) {
      console.warn("Workflow authoring reached its output limit", {
        maxTokens,
        usage: response.usage,
        textCharacters: response.message.content
          .filter((part) => part.type === "text")
          .reduce((count, part) => count + part.text.length, 0),
      });
      if (maxTokens < 32_768) continue;
      throw Error(
        "The model ran out of output tokens while writing the workflow, even after retrying with a larger budget. No workflow was started. Try authoring again.",
      );
    }
    if (response.errorMessage || response.stopReason !== "stop") {
      throw Error(response.errorMessage ?? `Authoring stopped: ${response.stopReason}`);
    }
    const source = response.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!source || source.includes("```")) throw Error("Expected bare Scheme source from author");
    return source;
  }
  throw Error("Workflow authoring did not finish");
}
