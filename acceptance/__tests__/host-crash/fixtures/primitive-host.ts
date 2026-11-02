import { appendFileSync } from "node:fs";
import { success } from "@sweatpants/foundation/computation";
import { createPrimitiveChatApp } from "@sweatpants/agent-host/primitive";
import { serve } from "@sweatpants/agent-host/node";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { approveRecord } from "../../../fixtures/approve-record.ts";
import type { TestApplicationFactoryContext } from "@sweatpants/test-rig";

process.once(
  "message",
  async (configuration: {
    database: string;
    effectLog: string;
    model: TestApplicationFactoryContext["model"]["model"];
    streamOptions: TestApplicationFactoryContext["model"]["streamOptions"];
  }) => {
    try {
      const app = createPrimitiveChatApp({
        database: configuration.database,
        program: { id: "approval-chat", version: "1", digest: "approval-chat-fixture-v1" },
        authorize: () => true, // Isolated loopback-only single-user test deployment.
        model: {
          identity: "scripted-model-v1",
          model: configuration.model,
          driver: createPiAiModelProvider().driver,
          streamOptions: configuration.streamOptions,
        },
        tools: [approveRecord],
        effects: {
          "approve_record.record": function* (input) {
            const { topic } = approveRecord.effects.record.input.parse(input);
            appendFileSync(
              configuration.effectLog,
              `${JSON.stringify({ pid: process.pid, topic })}\n`,
            );
            return success({ receipt: `${topic}-recorded` });
          },
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
