import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createPiAiProvider, describePiAiModel } from "@sweatpan.ts/providers-pi-ai";
import { prepareChatInference } from "@sweatpan.ts/chat";
import type { Runtime } from "@sweatpan.ts/runtime";

import type { ChatSampling } from "@sweatpan.ts/chat";

export async function createModelSampling<Y>(
  runtime: Runtime<Y>,
  publish: (text: string) => void,
): Promise<ChatSampling<Y>> {
  const providerName = process.env["CHAT_PROVIDER"] ?? "openai";
  const modelId = process.env["CHAT_MODEL"] ?? "gpt-6.1-sol";
  const models = builtinModels();
  const baseUrl = process.env["OPENAI_BASE_URL"];
  if (baseUrl) {
    const openai = openaiProvider();
    models.setProvider({
      ...openai,
      baseUrl,
      getModels: () => openai.getModels().map((model) => ({ ...model, baseUrl })),
      getAllModels: () =>
        (openai.getAllModels?.() ?? openai.getModels()).map((model) => ({ ...model, baseUrl })),
    });
  }
  const selected = models.getModel(providerName, modelId);
  if (!selected) {
    throw new Error("Configured model is not in the installed Pi catalog");
  }
  // Resolve configuration before opening the DB or accepting a durable turn.
  // Never print the returned credential or provider auth diagnostics.
  let configured = false;
  try {
    configured = Boolean(await models.getAuth(selected));
  } catch {
    throw new Error(
      `Authentication setup failed for ${providerName}. Check the server credentials.`,
    );
  }
  if (!configured) {
    throw new Error(
      `No credentials configured for ${providerName}. Configure the provider credential before starting yo-chat-v2.`,
    );
  }
  const model = describePiAiModel(selected);
  const provider = createPiAiProvider(runtime, {
    model: selected,
    stream: (sdkModel, context, options) => models.streamSimple(sdkModel, context, options),
  });
  return {
    *sample(request) {
      const inference = prepareChatInference({
        model,
        history: request.history,
        tools: request.tools,
        options: { toolChoice: request.tools.length ? "auto" : "none", maxTokens: 2048 },
      });
      publish("");
      const stream = yield* provider.stream(inference.request);
      while (true) {
        const item = yield* stream.next();
        if (item.done) {
          return { ok: true, value: { model, response: item.value } };
        }
        if (item.value.type === "text-delta" || item.value.type === "text-end") {
          publish(
            item.value.partial.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          );
        }
      }
    },
  };
}
