import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  withTestScenario,
  type TestApplication,
  type TestApplicationFactoryContext,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import type { ProgramDriverJournalStore } from "@sweatpants/durable-chat-runtime/durable-handler";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_EFFECT_NAME,
  DURABLE_SAMPLE_PROMPT_MARKER,
  DURABLE_SAMPLE_RESPONSE_MARKER,
  createAcceptanceApplication,
} from "../lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

function createReplacementFactory(databasePath: string): {
  createApplication(context: TestApplicationFactoryContext): Promise<TestApplication>;
  generations(): number;
  journalStore(): ProgramDriverJournalStore;
} {
  let journalStore: ProgramDriverJournalStore | undefined;
  let generation = 0;
  return {
    async createApplication(context) {
      generation += 1;
      const handle = await run(function* () {
        return yield* openBetterSqliteStorage(databasePath, { migrate: true, wal: true });
      });
      const application = createAcceptanceApplication(
        context,
        (inspection) => {
          journalStore = inspection.journalStore;
        },
        {
          conversationStore: handle.storage.conversationStore,
          executionStore: handle.storage.executionStore,
        },
      );
      return {
        ...application,
        async close() {
          try {
            await application.close();
          } finally {
            await run(() => handle.close());
          }
        },
      };
    },
    generations: () => generation,
    journalStore: () => {
      if (!journalStore) {
        throw new Error("replacement journal store was not installed");
      }
      return journalStore;
    },
  };
}

async function runScenario(binding: Binding): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "host-replacement-sqlite-"));
  const factory = createReplacementFactory(join(root, "authority.sqlite"));
  try {
    await withTestScenario(
      {
        binding,
        modelId: ACCEPTANCE_MODEL_ID,
        scenarioTimeoutMs: 30_000,
        createApplication: factory.createApplication,
      },
      function* (s) {
        const conversation = s.conversation({
          initialToolChoice: "required",
        });
        const turn = yield* conversation.send("HOST_REPLACEMENT_DURABLE_TURN_V1");

        const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* outer.respond.toolCalls([
          {
            id: "host-replacement-durable-call",
            name: ACCEPTANCE_DURABLE_TOOL_NAME,
            arguments: { topic: "replacement" },
          },
        ]);

        const nested = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* nested.respond.text(`${DURABLE_SAMPLE_RESPONSE_MARKER} Resume after replacement.`);

        const choose = yield* turn.elicit("chooseOption");
        yield* s.host.replace();
        expect(factory.generations()).toBe(2);

        yield* choose.accept({ selected: "replacement-alpha" });
        const final = yield* s.model.request((request) => {
          expect(request.body.model).toBe(ACCEPTANCE_MODEL_ID);
          expect(JSON.stringify(request.body.input)).not.toContain(DURABLE_SAMPLE_PROMPT_MARKER);
        });
        yield* final.respond.text("HOST_REPLACEMENT_TERMINAL_V1");

        expect((yield* turn.settled()).text).toBe("HOST_REPLACEMENT_TERMINAL_V1");
        expect(s.model.requests()).toHaveLength(3);

        const opened = yield* factory.journalStore().open(conversation.conversationId);
        const journal = yield* opened.readJournal(conversation.conversationId);
        expect(
          journal.filter(
            (entry) =>
              entry.payload.type === "PullRequested" &&
              entry.payload.descriptor.kind === "effect" &&
              entry.payload.descriptor.name === DURABLE_EFFECT_NAME,
          ),
        ).toHaveLength(1);
        expect(
          journal.filter(
            (entry) =>
              entry.payload.type === "PullRequested" &&
              entry.payload.descriptor.kind === "record" &&
              entry.payload.descriptor.key === "acceptance-recorded-value",
          ),
        ).toHaveLength(1);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("durable Turn Host replacement", () => {
  it("resumes a parked durable child after closing and reopening one SQLite file", async () => {
    await runScenario("http");
  }, 30_000);
});
