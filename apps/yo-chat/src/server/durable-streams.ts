import { call, type Operation } from "effection";
import {
  createInMemoryRegistryStore,
  createSharedStorage,
  getSharedStores,
  setupDurableStreams,
  type RetentionPolicy,
} from "@sweatpants/framework/chat/durable-streams";
import {
  FoldSessionBufferStoreContext,
  createSessionContractInMemoryStore,
} from "@sweatpants/framework/server";
import { createRedisTokenBufferStore } from "@sweatpants/durable-streams/redis";
import { getSharedRedisClient } from "@/lib/shared-redis";

const sharedStorage = createSharedStorage<string>();
const retainForeverPolicy: RetentionPolicy = { mode: "retain_forever" };

/**
 * Shared fold-session buffer store (module-level so all requests see the same
 * store). In-memory for now; Redis backing is a future concern since LogRecord
 * is an internal state-machine shape, not a wire event.
 */
const foldSessionBufferStore = createSessionContractInMemoryStore();

export function* setupYoChatDurableStreams(): Operation<void> {
  const client = yield* call(() => getSharedRedisClient());

  if (client) {
    yield* setupDurableStreams({
      bufferStore: createRedisTokenBufferStore<string>(client),
      registryStore: createInMemoryRegistryStore(),
      retentionPolicy: retainForeverPolicy,
    });
    yield* FoldSessionBufferStoreContext.set(foldSessionBufferStore);
    return;
  }

  const { bufferStore, registryStore } = getSharedStores(sharedStorage);
  yield* setupDurableStreams({
    bufferStore,
    registryStore,
    retentionPolicy: retainForeverPolicy,
  });
  yield* FoldSessionBufferStoreContext.set(foldSessionBufferStore);
}
