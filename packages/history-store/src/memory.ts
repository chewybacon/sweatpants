import { createMemoryDurableKernel } from "@sweatpants/durable-storage-kernel/memory";
import type { ConversationStore } from "./contract.ts";
import { createKernelConversationStore } from "./repository.ts";

/** In-memory conversation storage through the shared semantic repository. */
export function createMemoryConversationStore(): ConversationStore {
  return createKernelConversationStore(createMemoryDurableKernel());
}
