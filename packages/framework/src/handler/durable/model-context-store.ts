import type { Operation } from 'effection'
import type { TokenBufferStore } from '@sweatpants/durable-streams'

const THREAD_MODEL_CONTEXT_PREFIX = '__thread_model_context__:'

function threadModelContextStoreId(threadId: string): string {
  return `${THREAD_MODEL_CONTEXT_PREFIX}${threadId}`
}

export function* recordThreadSystemPrompt(
  bufferStore: TokenBufferStore<string>,
  threadId: string,
  systemPrompt: string,
): Operation<void> {
  const storeId = threadModelContextStoreId(threadId)
  const existing = yield* bufferStore.get(storeId)
  if (existing) {
    yield* bufferStore.delete(storeId)
  }

  const buffer = yield* bufferStore.create(storeId)
  const writer = yield* buffer.claimWriter({
    ownerId: `thread-model-context:${threadId}`,
    activationEpoch: 1,
  })
  yield* writer.append([systemPrompt])
  yield* writer.complete()
}

export function* readLatestThreadSystemPrompt(
  bufferStore: TokenBufferStore<string>,
  threadId: string,
): Operation<string | null> {
  const storeId = threadModelContextStoreId(threadId)
  const buffer = yield* bufferStore.get(storeId)
  if (!buffer) return null

  const { tokens } = yield* buffer.read(0)
  return tokens[tokens.length - 1] ?? null
}
