import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  withTestScenario,
  type ScenarioContext,
  type ScriptConversation,
} from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "../lib/acceptance-app.ts";
import {
  createSqliteWriterBinding,
  type BetterSqliteBinding,
} from "@sweatpants/storage-sqlite/better-sqlite3";
import { createChatStorageClient } from "@sweatpants/storage-sqlite/client";
import { sqliteSchema } from "@sweatpants/storage-sqlite/schema";

const directories: string[] = [];
const bindings: BetterSqliteBinding[] = [];

afterEach(() => {
  for (const binding of bindings.splice(0).reverse()) {
    try {
      binding.close();
    } catch {
      // Teardown best effort.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const CONVERSATION_ID = "storage-client-api-thread";

function applicationOver(binding: BetterSqliteBinding) {
  return (context: Parameters<typeof createAcceptanceApplication>[0]) =>
    createAcceptanceApplication(context, undefined, {
      storage: { kind: "sqlite", database: binding },
    });
}

/**
 * The full author flow from the specification: the application owns a SQLite
 * binding, hands it to the chat composition, a real (fake-provider) turn
 * persists, the drizzle client façade discovers the thread, and a fresh
 * application generation on a fresh binding to the same file rediscovers it —
 * the thread-list survival the in-memory sidebar could never provide.
 */
describe("storage client API end to end", () => {
  it("persists a real turn across generations with a caller-owned binding (TC-018)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "storage-client-api-e2e-"));
    directories.push(directory);
    const databasePath = join(directory, "app.sqlite");

    // Generation one: own binding, compose, send one real turn.
    const first = createSqliteWriterBinding(databasePath);
    bindings.push(first);
    await withTestScenario(
      {
        binding: "in-process",
        modelId: ACCEPTANCE_MODEL_ID,
        scenarioTimeoutMs: 30_000,
        createApplication: applicationOver(first),
      },
      function* (scenario: ScenarioContext) {
        const conversation = scenario.conversation({ conversationId: CONVERSATION_ID });
        const turn = yield* conversation.send(
          "STORAGE_CLIENT_API_TURN use the immediate fixture tool.",
        );
        const initial = yield* scenario.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* initial.respond.text("STORAGE_CLIENT_API_RESULT");
        const settled = yield* turn.settled();
        expect(settled.text).toContain("STORAGE_CLIENT_API_RESULT");

        // The façade discovers the thread the moment the turn lands.
        const client = createChatStorageClient(drizzle(first, { schema: sqliteSchema }));
        expect(client.threads.list().map((thread) => thread.id)).toContain(CONVERSATION_ID);
        expect(client.threads.get(CONVERSATION_ID)).toMatchObject({ id: CONVERSATION_ID });
      },
    );

    // Generation two: a brand-new binding to the same filename, exactly what
    // a server restart creates. Only the filename is shared.
    const second = createSqliteWriterBinding(databasePath);
    bindings.push(second);
    expect(second).not.toBe(first);
    await withTestScenario(
      {
        binding: "in-process",
        modelId: ACCEPTANCE_MODEL_ID,
        scenarioTimeoutMs: 30_000,
        createApplication: applicationOver(second),
      },
      function* (scenario: ScenarioContext) {
        const conversation: ScriptConversation = scenario.conversation({
          conversationId: CONVERSATION_ID,
        });
        const reopened = yield* conversation.reopen();
        const refreshed = reopened.snapshot();
        expect(JSON.stringify(refreshed)).toContain("STORAGE_CLIENT_API_TURN");
        expect(JSON.stringify(refreshed)).toContain("STORAGE_CLIENT_API_RESULT");

        const client = createChatStorageClient(drizzle(second, { schema: sqliteSchema }));
        expect(client.threads.get(CONVERSATION_ID)).toMatchObject({ id: CONVERSATION_ID });
        expect(client.threads.list().map((thread) => thread.id)).toContain(CONVERSATION_ID);
        const page = client.transcript.page(CONVERSATION_ID);
        expect(page.entries.length).toBeGreaterThan(0);
        expect(JSON.stringify(page.entries)).toContain("STORAGE_CLIENT_API_RESULT");
      },
    );
  }, 60_000);
});
