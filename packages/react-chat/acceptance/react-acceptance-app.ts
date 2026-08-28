import { createToolInventoryEntry } from "@sweatpants/tool-runtime";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Operation } from "effection";
import { createChatApplication, createChatEndpoints } from "@sweatpants/agent-host/server";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import {
  createProgramDriverJournalStore,
  createProjectionTokenKeyring,
  programDriverSchemaRegistry,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { createToolInventory, installToolInventory } from "@sweatpants/tool-runtime";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { ProgramDriverEphemeralEffectsContext } from "@sweatpants/durable-chat-runtime/program-driver/effects";
import {
  createLocalToolInvocationRuntime,
  installLocalToolRuntimeComposition,
} from "@sweatpants/tool-runtime-local";
import {
  routeNativeChatTestApplication,
  type TestApplication,
  type TestApplicationFactoryContext,
} from "@sweatpants/test-rig";
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

  const endpoints = createChatEndpoints({
    programDriverJournalStore: journalStore,
    projectionTokens: createProjectionTokenKeyring("react-acceptance-windowed-projection-key"),
    *authorizeHistoryRead() {
      return "authorized" as const;
    },
    setup: function* (): Operation<void> {
      yield* context.model.install();
    },
  });
  const application = createChatApplication({
    setup: function* (): Operation<void> {
      yield* setupInMemoryDurableStreams<string>({
        retentionPolicy: { mode: "retain_forever" },
      });
      yield* installToolInventory(inventory);
      yield* createLocalToolInvocationRuntime({
        worker: { workerUrl: workerBootstrapUrl(), isDev: false },
      });
      yield* installLocalToolRuntimeComposition({
        tools: [reactBookingTool],
        installEphemeralEffects: function* (registrations) {
          yield* ProgramDriverEphemeralEffectsContext.set(registrations);
        },
        samplingProvider: {
          *sample() {
            throw new Error("React acceptance tool does not perform nested sampling");
          },
        },
      });
    },
    handler: endpoints.postChat,
  });
  return routeNativeChatTestApplication(application, endpoints);
}
