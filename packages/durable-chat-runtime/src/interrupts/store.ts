import type { Operation } from "effection";
import type { TokenBufferStore } from "@sweatpants/durable-streams";

import type { OpenInterruptRecord } from "./registry.ts";

const THREAD_INTERRUPT_PREFIX = "__thread_interrupts__:";

function threadInterruptStoreId(threadId: string): string {
  return `${THREAD_INTERRUPT_PREFIX}${threadId}`;
}

export function* recordThreadInterruptState(
  bufferStore: TokenBufferStore<string>,
  threadId: string,
  records: OpenInterruptRecord[],
): Operation<void> {
  const storeId = threadInterruptStoreId(threadId);
  const existing = yield* bufferStore.get(storeId);
  if (existing) {
    yield* bufferStore.delete(storeId);
  }

  const buffer = yield* bufferStore.create(storeId);
  const writer = yield* buffer.claimWriter({
    ownerId: `thread-interrupts:${threadId}`,
    activationEpoch: 1,
  });
  yield* writer.append([JSON.stringify(records)]);
  yield* writer.complete();
}

export function* readLatestThreadInterruptState(
  bufferStore: TokenBufferStore<string>,
  threadId: string,
): Operation<OpenInterruptRecord[] | null> {
  const storeId = threadInterruptStoreId(threadId);
  const buffer = yield* bufferStore.get(storeId);
  if (!buffer) {
    return null;
  }

  const { tokens } = yield* buffer.read(0);
  const latest = tokens[tokens.length - 1];
  if (!latest) {
    return null;
  }

  try {
    const parsed = JSON.parse(latest) as unknown;
    return Array.isArray(parsed) ? (parsed as OpenInterruptRecord[]) : null;
  } catch {
    return null;
  }
}
