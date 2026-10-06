import type { D1Database } from "@cloudflare/workers-types";
import { call, type Operation } from "effection";
import { createKernelConversationStore } from "@sweatpants/history-store/repository";
import { createKernelExecutionStore } from "@sweatpants/journal-authority/store-repository";
import { createD1DurableKernel, type D1KernelOptions } from "./kernel.ts";
import { initializeD1Storage } from "./schema.ts";
export { createD1DurableKernel, type D1KernelOptions } from "./kernel.ts";
export { initializeD1Storage } from "./schema.ts";

export function createD1Storage(database: D1Database, options?: D1KernelOptions) {
  const kernel = createD1DurableKernel(database, options);
  return {
    kind: "custom" as const,
    conversationStore: createKernelConversationStore(kernel),
    executionStore: createKernelExecutionStore(kernel),
  };
}

/** Caller-owned D1 binding; this opens/provisions storage without owning its lifetime. */
export function* openD1Storage(
  database: D1Database,
): Operation<ReturnType<typeof createD1Storage>> {
  yield* call(() => initializeD1Storage(database));
  return createD1Storage(database);
}
