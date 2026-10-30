// @vitest-environment node
import { local } from "@sweatpants/tool-runtime-local";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { race } from "effection";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import {
  withTestScenario,
  type TestApplicationFactoryContext,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import { createLocalYoChatApplication } from "../src/server/local-chat-application.ts";
import { pickCard } from "../src/tools/pick-card/durable.ts";
const MODEL_ID = "yo-chat-pick-card-acceptance";
type Binding = TestRigOptions["binding"];
function createPickCardApplication(context: TestApplicationFactoryContext) {
  const directory = mkdtempSync(resolve(tmpdir(), "yo-chat-worker-card-"));
  const app = createLocalYoChatApplication({
    database: resolve(directory, "chat.sqlite"),
    model: {
      identity: MODEL_ID,
      model: context.model.model,
      driver: createPiAiModelProvider().driver,
      streamOptions: context.model.streamOptions,
    },
    execution: local({
      worker: new URL("../src/server/journal-tool-worker-bootstrap.mjs", import.meta.url),
      execArgv: ["--conditions=development"],
    }),
  });
  return {
    handle(request: Request) {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/^\/assistant\/chat/, "/api/chat");
      return app.handler(new Request(url, request));
    },
    async close() {
      try {
        await app.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
async function runScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: MODEL_ID,
      createApplication: createPickCardApplication,
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
      yield* resumed.settled();
      expect(JSON.stringify(reconnected.snapshot().messages)).toContain(
        `You picked the ${selected.rank}`,
      );
      expect(reconnected.snapshot()).toMatchObject({
        canSendMessage: true,
        authority: { state: "idle" },
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
      yield* second.settled();
      expect(JSON.stringify(reconnected.snapshot().messages)).toContain(
        "Ready to pick another card.",
      );
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "yo-chat journal worker pick_card terminal publication through %s",
  (binding) => {
    it("admits the next ordinary message after the fulfilled turn completes", async () => {
      await runScenario(binding);
    }, 30_000);
  },
);
