import { call, type Operation } from "effection";
import {
  createProgramDriverJournalStore,
  programDriverSchemaRegistry,
  type ProgramDriverJournal,
  type ProgramDriverJournalStore,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { createRedisExecutionStore } from "@sweatpants/execution-store-redis";
import type { RedisClientType } from "redis";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import type { CapabilityKeyring, ExecutionStore } from "@sweatpants/journal-authority";

import { getSharedRedisClient } from "@/lib/shared-redis";
import { pickCard } from "../tools/pick-card/durable";
import { playTttTool } from "../tools/play-ttt/tool";

const yoChatProgramSchemaEntries = [
  ...pickCard.artifacts.catalog,
  ...playTttTool.artifacts.catalog,
];

/** Creates the yo-chat ProgramRuntime journal adapter over shared Redis or development memory. */
export function createYoChatProgramDriverJournalStore(
  keyring: CapabilityKeyring,
  executionStore: ExecutionStore = createYoChatExecutionStore(),
): ProgramDriverJournalStore {
  return createProgramDriverJournalStore({
    keyring,
    journalPrefix: "yo-chat-program-driver",
    schemaRegistry: programDriverSchemaRegistry(yoChatProgramSchemaEntries),
    executionStore,
  });
}

/** Selects one production store once; configured Redis and local memory never mix. */
export function createYoChatExecutionStore(): ExecutionStore {
  const memory = createMemoryExecutionStore();
  let selected: ExecutionStore | undefined;

  function* store(): Operation<ExecutionStore> {
    if (!selected) {
      const client = yield* call(() => getSharedRedisClient());
      selected = client
        ? createRedisExecutionStore(client, { keyPrefix: "sweatpants:execution-store:v1:" })
        : memory;
    }
    return selected;
  }

  return {
    *loadExecution(executionId) {
      return yield* (yield* store()).loadExecution(executionId);
    },
    *commitExecution(request) {
      return yield* (yield* store()).commitExecution(request);
    },
    *putPayload(value) {
      return yield* (yield* store()).putPayload(value);
    },
    *getPayload(reference) {
      return yield* (yield* store()).getPayload(reference);
    },
    *appendReplay(request) {
      return yield* (yield* store()).appendReplay(request);
    },
    *readReplay(head) {
      return yield* (yield* store()).readReplay(head);
    },
  };
}

/** Creates a ProgramRuntime journal store over the bounded Redis Execution Store. */
export function createRedisProgramDriverJournalStore(
  client: RedisClientType,
  keyring: CapabilityKeyring,
  schemaRegistry = programDriverSchemaRegistry(yoChatProgramSchemaEntries),
): ProgramDriverJournalStore {
  return createProgramDriverJournalStore({
    keyring,
    journalPrefix: "yo-chat-program-driver",
    schemaRegistry,
    executionStore: createRedisExecutionStore(client, {
      keyPrefix: "sweatpants:execution-store:v1:",
    }),
  });
}
