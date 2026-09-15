import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { run } from "effection";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { describeExecutionStoreConformance } from "@sweatpants/journal-authority/store-conformance";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import { describeConversationStoreConformance } from "@sweatpants/history-store/conformance";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sqliteConversationCase() {
  return {
    name: "sqlite",
    async create() {
      const path = await temporaryDatabase();
      const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));
      return {
        store: handle.storage.conversationStore,
        close: () => run(() => handle.close()),
      };
    },
  };
}

function sqliteExecutionCase() {
  return {
    name: "sqlite",
    async create() {
      const path = await temporaryDatabase();
      const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));
      return {
        store: handle.storage.executionStore,
        close: () => run(() => handle.close()),
      };
    },
  };
}

describeConversationStoreConformance([
  {
    name: "memory",
    create: async () => ({ store: createMemoryConversationStore(), close: async () => undefined }),
  },
  sqliteConversationCase(),
]);

describeExecutionStoreConformance([
  {
    name: "memory",
    create: async () => ({ store: createMemoryExecutionStore(), close: async () => undefined }),
  },
  sqliteExecutionCase(),
]);
