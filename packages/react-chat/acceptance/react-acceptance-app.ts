import { createToolInventoryEntry } from "@sweatpants/tool-runtime";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Operation } from "effection";
import { createChatApplication, createChatHandler } from "@sweatpants/agent-host/server";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import {
  createProgramDriverJournalStore,
  createProjectionTokenKeyring,
  programDriverSchemaRegistry,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { createToolInventory, installToolInventory } from "@sweatpants/tool-runtime";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { ProgramDriverForeignEffectsContext } from "@sweatpants/durable-chat-runtime/program-driver/effects";
import {
  createInMemoryToolSessionStoreWithDebug,
  createToolSessionRegistry,
  installLocalProgramToolRuntime,
} from "@sweatpants/tool-runtime-local";
import type { TestApplication, TestApplicationFactoryContext } from "@sweatpants/test-rig";
import { reactBookingTool } from "./fixtures/react-booking.tool.ts";

export const REACT_ACCEPTANCE_MODEL_ID = "react-chat-acceptance";

function workerBootstrapUrl(): URL {
  const candidates = [
    resolve(process.cwd(), "acceptance/fixtures/react-tool-worker-bootstrap.mjs"),
    resolve(
      process.cwd(),
      "packages/react-chat/acceptance/fixtures/react-tool-worker-bootstrap.mjs",
    ),
  ];
  const candidate = candidates.find(existsSync);
  if (!candidate) {
    throw new Error("Failed to resolve React acceptance worker bootstrap");
  }
  return pathToFileURL(candidate);
}

export function createReactAcceptanceApplication(
  context: TestApplicationFactoryContext,
): TestApplication {
  const inventory = createToolInventory([createToolInventoryEntry(reactBookingTool)]);
  const journalStore = createProgramDriverJournalStore({
    keyring: createCapabilityKeyring("react-chat-acceptance", [
      {
        keyId: "test-v1",
        secret: "react-chat-acceptance-secret-at-least-32-bytes",
      },
    ]),
    schemaRegistry: programDriverSchemaRegistry(reactBookingTool.artifacts.catalog),
  });

  return createChatApplication({
    setup: function* (): Operation<void> {
      yield* setupInMemoryDurableStreams<string>({
        retentionPolicy: { mode: "retain_forever" },
      });
      yield* installToolInventory(inventory);
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStoreWithDebug(), {
        worker: { workerUrl: workerBootstrapUrl(), isDev: false },
      });
      yield* installLocalProgramToolRuntime({
        tools: [reactBookingTool],
        registry,
        installForeignEffects: function* (registrations) {
          yield* ProgramDriverForeignEffectsContext.set(registrations);
        },
        samplingProvider: {
          *sample() {
            throw new Error("React acceptance tool does not perform nested sampling");
          },
        },
      });
    },
    handler: createChatHandler({
      programDriverJournalStore: journalStore,
      projectionTokens: createProjectionTokenKeyring("react-acceptance-windowed-projection-key"),
      *authorizeHistoryRead() {
        return "authorized" as const;
      },
      setup: function* (): Operation<void> {
        yield* context.model.install();
      },
    }),
  });
}
