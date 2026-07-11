import { call, type Operation } from "effection";
import {
  createInMemoryRegistryStore,
  createSharedStorage,
  getSharedStores,
  setupDurableStreams,
  type RetentionPolicy,
} from "@sweatpants/framework/chat/durable-streams";
import { CrankStoreContext, createInMemoryCrankStore } from "@sweatpants/framework/server";
import { createRedisTokenBufferStore } from "@sweatpants/durable-streams/redis";
import { getSharedRedisClient } from "@/lib/shared-redis";

const sharedStorage = createSharedStorage<string>();
const retainForeverPolicy: RetentionPolicy = { mode: "retain_forever" };

/** Shared fenced replay-crank store. Parked sessions retain no process. */
const crankStore = createInMemoryCrankStore();

export function* setupYoChatDurableStreams(): Operation<void> {
  const client = yield* call(() => getSharedRedisClient());

  if (client) {
    yield* setupDurableStreams({
      bufferStore: createRedisTokenBufferStore<string>(client),
      registryStore: createInMemoryRegistryStore(),
      retentionPolicy: retainForeverPolicy,
    });
    yield* CrankStoreContext.set(crankStore);
    return;
  }

  const { bufferStore, registryStore } = getSharedStores(sharedStorage);
  yield* setupDurableStreams({
    bufferStore,
    registryStore,
    retentionPolicy: retainForeverPolicy,
  });
  yield* CrankStoreContext.set(crankStore);
}
