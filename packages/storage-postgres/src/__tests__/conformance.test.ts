import { run } from "effection";
import { describeExecutionStoreConformance } from "@sweatpants/journal-authority/store-conformance";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import { describeConversationStoreConformance } from "@sweatpants/history-store/conformance";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import { openPostgresStorage } from "../pg-binding.ts";

/** The Docker harness always listens here; override via SWEATPANTS_DATABASE_URL. */
const connectionString =
  process.env.SWEATPANTS_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:55432/sweatpants_test";

function postgresConversationCase() {
  return {
    name: "postgres",
    async create() {
      const handle = await openPostgresStorage({ connectionString, migrate: true });
      return {
        store: handle.storage.conversationStore as ConversationStore,
        close: () => run(() => handle.close()),
      };
    },
  };
}

function postgresExecutionCase() {
  return {
    name: "postgres",
    async create() {
      const handle = await openPostgresStorage({ connectionString, migrate: true });
      return {
        store: handle.storage.executionStore as ExecutionStore,
        close: () => run(() => handle.close()),
      };
    },
  };
}

describeConversationStoreConformance([postgresConversationCase()]);
describeExecutionStoreConformance([postgresExecutionCase()]);
