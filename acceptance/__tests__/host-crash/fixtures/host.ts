import { appendFileSync } from "node:fs";
import { createChatApp, inProcess } from "@sweatpants/agent-host/server";
import { serve } from "@sweatpants/agent-host/node";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { durableSelection, selectionEffects } from "../../../fixtures/durable-selection.ts";
import type { TestApplicationFactoryContext } from "@sweatpants/test-rig";

type Configuration = {
  database: string;
  effectLog: string;
  model: TestApplicationFactoryContext["model"]["model"];
  streamOptions: TestApplicationFactoryContext["model"]["streamOptions"];
};
process.once("message", async (configuration: Configuration) => {
  try {
    const app = createChatApp({
      name: "crash-acceptance",
      secret: "crash-acceptance-secret-at-least-32-bytes",
      storage: { kind: "sqlite", path: configuration.database },
      basePath: "/assistant/chat",
      tools: [durableSelection],
      execution: inProcess(),
      effects: selectionEffects((topic) =>
        appendFileSync(configuration.effectLog, `${JSON.stringify({ pid: process.pid, topic })}\n`),
      ),
      model: {
        model: configuration.model,
        driver: createPiAiModelProvider().driver,
        streamOptions: configuration.streamOptions,
      },
      setup: {
        application: function* () {
          yield* setupInMemoryDurableStreams<string>({
            retentionPolicy: { mode: "retain_forever" },
          });
        },
      },
    });
    const server = await serve(app, { hostname: "127.0.0.1", port: 0 });
    process.send?.({ origin: server.origin, pid: process.pid });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
