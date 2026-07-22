import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Operation } from "effection";
import {
  createCapabilityKeyring,
  createChatApplication,
  createChatHandler,
  createInMemoryProgramDriverJournalStore,
  programDriverSchemaRegistry,
} from "@sweatpants/framework/server";
import {
  createToolInventory,
  createToolInventoryEntry,
  ToolInventoryContext,
} from "@sweatpants/framework/chat";
import { setupInMemoryDurableStreams } from "@sweatpants/framework/chat/durable-streams";
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
  const journalStore = createInMemoryProgramDriverJournalStore({
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
      yield* ToolInventoryContext.set(inventory);
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStoreWithDebug(), {
        worker: { workerUrl: workerBootstrapUrl(), isDev: false },
      });
      yield* installLocalProgramToolRuntime({
        tools: [reactBookingTool],
        registry,
        samplingProvider: {
          *sample() {
            throw new Error("React acceptance tool does not perform nested sampling");
          },
        },
      });
    },
    handler: createChatHandler({
      programDriverJournalStore: journalStore,
      setup: function* (): Operation<void> {
        yield* context.model.install();
      },
    }),
  });
}
