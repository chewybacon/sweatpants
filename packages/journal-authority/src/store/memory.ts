import { createMemoryDurableKernel } from "@sweatpants/durable-storage-kernel/memory";
import type { ExecutionStore } from "./store.ts";
import { createKernelExecutionStore } from "./store-repository.ts";

/** In-memory execution storage through the shared semantic repository. */
export function createMemoryExecutionStore(): ExecutionStore {
  return createKernelExecutionStore(createMemoryDurableKernel());
}
