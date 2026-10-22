import { createChatApp, type ChatAppConfig } from "@sweatpants/agent-host/server";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import type { TestApplicationFactoryContext } from "@sweatpants/test-rig";

/** Model wiring and lifetime only; each suite supplies its public composition. */
export function createApplication(
  context: TestApplicationFactoryContext,
  options: Partial<ChatAppConfig> = {},
) {
  const application = createChatApp({
    name: "public-acceptance",
    secret: "public-acceptance-secret-at-least-32-bytes",
    storage: { kind: "memory" },
    tools: [],
    basePath: "/assistant/chat",
    model: {
      model: context.model.model,
      driver: createPiAiModelProvider().driver,
      streamOptions: context.model.streamOptions,
    },
    setup: {
      application: function* () {
        yield* setupInMemoryDurableStreams<string>({ retentionPolicy: { mode: "retain_forever" } });
      },
    },
    ...options,
  });
  return {
    handle: application.handler,
    close: () => application.close(),
    inspect: () => application.inspect(),
  };
}
