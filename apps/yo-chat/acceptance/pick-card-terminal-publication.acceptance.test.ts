import { describe, expect, it } from "vitest";
import { createChatApplication, createChatEndpoints } from "@sweatpants/agent-host/server";
import { durableEffectKey } from "@sweatpants/durable-effects";
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { createLocalWorkerDurableProgramDriver } from "@sweatpants/tool-runtime-local";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import {
  createProgramDriverJournalStore,
  createProjectionTokenKeyring,
  programDriverSchemaRegistry,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { ProgramDriverNativeToolsContext } from "@sweatpants/durable-chat-runtime/program-driver/native-tools";
import { projectAvailableToolContracts } from "@sweatpants/durable-chat-runtime/tool-inventory";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import {
  createToolInventory,
  createToolInventoryEntry,
  installToolInventory,
} from "@sweatpants/tool-runtime";
import { exactProgramKey } from "@sweatpants/tool-runtime-agentcore";
import {
  withTestScenario,
  type TestApplicationFactoryContext,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import { race, type Operation } from "effection";
import { pickCard } from "../src/tools/pick-card/durable.ts";
import { createDrawPickCardsRegistration } from "../src/tools/pick-card/durable-effects.ts";
import { routeNativeChatApplication } from "./fixtures/native-chat-router.ts";

const MODEL_ID = "yo-chat-pick-card-acceptance";
type Binding = TestRigOptions["binding"];

function pickCardWorkerUrl(): URL {
  const candidates = [
    resolve(process.cwd(), "acceptance/fixtures/durable-pick-card-worker-bootstrap.mjs"),
    resolve(
      process.cwd(),
      "apps/yo-chat/acceptance/fixtures/durable-pick-card-worker-bootstrap.mjs",
    ),
  ];
  const candidate = candidates.find(existsSync);
  if (!candidate) {
    throw new Error("Failed to resolve durable pick_card worker bootstrap");
  }
  return pathToFileURL(candidate);
}

function createPickCardApplication(
  context: TestApplicationFactoryContext,
  inspect: (conversationStore: ConversationStore) => void,
) {
  const executionStore = createMemoryExecutionStore();
  const conversationStore = createMemoryConversationStore();
  inspect(conversationStore);
  const journalStore = createProgramDriverJournalStore({
    keyring: createCapabilityKeyring("yo-chat-pick-card-acceptance", [
      {
        keyId: "test-v1",
        secret: "yo-chat-pick-card-acceptance-secret-at-least-32-bytes",
      },
    ]),
    schemaRegistry: programDriverSchemaRegistry(pickCard.artifacts.catalog),
    executionStore,
  });
  const registry = createDurableToolRegistry([pickCard]);
  const drawCards = createDrawPickCardsRegistration();
  const schemaRegistry = programDriverSchemaRegistry(pickCard.artifacts.catalog);
  const available = projectAvailableToolContracts([pickCard], {
    ordinaryTools: new Set(),
    drivers: new Set(["worker"]),
    programs: new Set([
      exactProgramKey({
        id: pickCard.manifest.programId,
        version: pickCard.manifest.version,
        digest: pickCard.manifest.digest,
      }),
    ]),
    effects: new Set(
      Object.values(pickCard.manifest.effects).map((effect) =>
        durableEffectKey(effect.name, effect.version),
      ),
    ),
    schemas: schemaRegistry,
    durableDrivers: new Map([[pickCard.name, "worker"]]),
  });
  const driver = createLocalWorkerDurableProgramDriver({
    workerUrl: pickCardWorkerUrl(),
    name: "yo-chat-pick-card-acceptance",
    registry,
  });

  const endpoints = createChatEndpoints({
    storage: { kind: "custom", executionStore, conversationStore },
    createProgramDriverJournalStore: () => journalStore,
    projectionTokens: createProjectionTokenKeyring("yo-chat-pick-card-window-projection-key"),
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
      yield* installToolInventory(
        createToolInventory(available.map((tool) => createToolInventoryEntry(tool))),
      );
      yield* ProgramDriverNativeToolsContext.set({
        bindings: new Map([
          [
            pickCard.name,
            {
              publicName: pickCard.name,
              tool: pickCard,
              route: { driverKind: "worker", profile: "pick-card-acceptance" },
            },
          ],
        ]),
        drivers: [["worker", driver]],
        effects: [drawCards],
      });
    },
    handler: endpoints.postChat,
  });
  return routeNativeChatApplication(application, endpoints);
}

async function runScenario(binding: Binding): Promise<void> {
  let conversationStore: ConversationStore | undefined;
  await withTestScenario(
    {
      binding,
      modelId: MODEL_ID,
      createApplication(context) {
        return createPickCardApplication(context, (store) => {
          conversationStore = store;
        });
      },
      scenarioTimeoutMs: 20_000,
    },
    function* (s) {
      const conversation = s.conversation({ initialToolChoice: "required" });
      const first = yield* conversation.send("Draw a card and let me pick one.");
      const outer = yield* race([
        s.model.request({ model: MODEL_ID }),
        (function* () {
          const failure = yield* first.failure();
          throw new Error(`pick_card failed before outer model request: ${failure.message}`);
        })(),
      ]);
      yield* outer.respond.toolCalls([
        {
          id: "pick-card-call-1",
          name: pickCard.name,
          arguments: { count: 3 },
        },
      ]);

      const choice = yield* first.elicit("pickCard");
      const reconnected = yield* conversation.reopen();
      expect(JSON.stringify(reconnected.snapshot())).toContain(choice.elicitId);
      const resumed = reconnected.resumePendingElicit("pickCard");
      const recoveredChoice = yield* resumed.elicit("pickCard");
      expect(recoveredChoice.elicitId).toBe(choice.elicitId);
      const context = recoveredChoice.context as {
        readonly cards: readonly {
          readonly rank: string;
          readonly suit: string;
          readonly display: string;
        }[];
      };
      const selected = context.cards[0];
      if (!selected) {
        throw new Error("pick_card did not offer a card");
      }
      yield* recoveredChoice.accept({ picked: selected });

      const final = yield* race([
        s.model.request({ model: MODEL_ID }),
        (function* () {
          const failure = yield* resumed.failure();
          throw new Error(`pick_card failed before final model request: ${failure.message}`);
        })(),
      ]);
      expect(JSON.stringify(final.body.input)).toContain("Card selection recorded");
      yield* final.respond.text(`You picked the ${selected.rank} of ${selected.suit}.`);
      expect((yield* resumed.settled()).text).toContain(`You picked the ${selected.rank}`);
      expect(reconnected.snapshot()).toMatchObject({
        canSendMessage: true,
        authority: { state: "idle" },
      });
      if (!conversationStore) {
        throw new Error("ConversationStore inspection was not installed");
      }
      expect(yield* conversationStore.loadHead(conversation.conversationId)).toMatchObject({
        state: "idle",
        activeExecutionId: null,
        activeLogicalTurnId: null,
      });

      const second = yield* reconnected.send("Pick another one.");
      const next = yield* race([
        s.model.request({ model: MODEL_ID }),
        (function* () {
          const failure = yield* second.failure();
          throw new Error(`successor failed before model admission: ${failure.message}`);
        })(),
      ]);
      expect(JSON.stringify(next.body.input)).toContain("Pick another one.");
      yield* next.respond.text("Ready to pick another card.");
      expect((yield* second.settled()).text).toBe("Ready to pick another card.");
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "yo-chat pick_card terminal publication through %s",
  (binding) => {
    it("admits the next ordinary message after the fulfilled turn completes", async () => {
      await runScenario(binding);
    }, 30_000);
  },
);
