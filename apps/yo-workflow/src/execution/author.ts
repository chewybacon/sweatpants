import { run } from "effection";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { createWorkflowModels } from "../server/cloudflare/model-catalog.ts";
import { reasoningLevel } from "../server/model-settings.ts";

/** Authoring is host work; the generated caller is pinned before execution opens. */
export async function authorCaller(
  prompt: string,
  validate: (source: string) => Promise<string>,
  config: {
    models: ReturnType<typeof createWorkflowModels>;
    provider: string;
    model: string;
    thinking?: string;
  },
): Promise<string> {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
    throw Error("Describe a workflow in 1–4000 characters");
  }
  const provider = createPiAiModelProvider({
    models: config.models,
  });
  const model = provider.resolveModel({
    provider: config.provider,
    id: config.model,
  });
  const signal = AbortSignal.timeout(180_000);
  let feedback = "";
  for (const maxTokens of [16_384, 32_768, 32_768]) {
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
The host supplies title, recipient, and metadata in input; pass input directly to both tools. Do not invent JSON literal syntax.
User request: ${prompt}
${feedback}`,
                },
              ],
            },
          ],
          tools: [],
        },
        {
          thinking: reasoningLevel(config.thinking),
          maxTokens,
          signal,
        },
      );
      while (true) {
        const next = yield* stream.next();
        if (next.done) {
          return next.value;
        }
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
      if (maxTokens < 32_768) {
        continue;
      }
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
    const diagnostic =
      !source || source.includes("```")
        ? "Expected bare Scheme source, without Markdown or explanation"
        : await validate(source);
    if (!diagnostic) {
      return source;
    }
    feedback = `Your previous response was rejected before execution. Rewrite the complete caller as bare Scheme only. Validator feedback: ${diagnostic.slice(0, 2000)}`;
    console.warn("Workflow authoring validation rejected source", { diagnostic });
  }
  throw Error(`Workflow authoring failed validation after three attempts. ${feedback}`);
}
