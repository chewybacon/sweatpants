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

/** Creates the yo-chat workflow host journal adapter over shared Redis or development memory. */
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
    *loadControl(executionId) {
      const execution = yield* store();
      return yield* execution.loadControl(executionId);
    },
    *commitExecution(request) {
      const execution = yield* store();
      return yield* execution.commitExecution(request);
    },
    *putObject(object) {
      const execution = yield* store();
      return yield* execution.putObject(object);
    },
    *getObject(pointer) {
      const execution = yield* store();
      return yield* execution.getObject(pointer);
    },
    *appendJournalSegment(segment) {
      const execution = yield* store();
      return yield* execution.appendJournalSegment(segment);
    },
    *appendReplaySegment(segment) {
      const execution = yield* store();
      return yield* execution.appendReplaySegment(segment);
    },
    *readJournal(task) {
      const execution = yield* store();
      return yield* execution.readJournal(task);
    },
    *readReplay(task) {
      const execution = yield* store();
      return yield* execution.readReplay(task);
    },
  };
}

/** Creates a workflow host journal store over the bounded Redis Execution Store. */
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
