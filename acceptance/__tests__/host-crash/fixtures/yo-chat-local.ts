import { resource, suspend } from "effection";
import { appendFileSync, existsSync } from "node:fs";
import { createLocalYoChatApplication } from "../../../../apps/yo-chat/src/server/local-chat-application.ts";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { serve } from "@sweatpants/agent-host/node";
import type { TestApplicationFactoryContext } from "@sweatpants/test-rig";

process.once(
  "message",
  async (config: {
    database: string;
    effectLog: string;
    model: TestApplicationFactoryContext["model"]["model"];
    streamOptions: TestApplicationFactoryContext["model"]["streamOptions"];
  }) => {
    try {
      const provider = createPiAiModelProvider().driver;
      const app = createLocalYoChatApplication({
        database: config.database,
        model: {
          identity: "scripted",
          model: config.model,
          driver: {
            ...provider,
            *stream(request) {
              const stream = yield* provider.stream(request);
              return resource(function* (provide) {
                try {
                  const subscription = yield* stream;
                  yield* provide(subscription);
                } finally {
                  if (config.effectLog.endsWith(".stop-ready") && !existsSync(config.effectLog)) {
                    appendFileSync(config.effectLog, "provider cleanup entered\n");
                    // A controlled native finalizer boundary, killed by the parent after Stop admission.
                    yield* suspend();
                  }
                }
              });
            },
          },
          streamOptions: config.streamOptions,
        },
      });
      const server = await serve(app, { hostname: "127.0.0.1", port: 0 });
      process.send?.({ origin: server.origin, pid: process.pid });
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  },
);
