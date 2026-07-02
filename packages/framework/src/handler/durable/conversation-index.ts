import type { Operation } from 'effection'
import type { TokenBufferStore } from '@sweatpants/durable-streams'

const CONVERSATION_INDEX_PREFIX = '__conversation_index__:'
const CONVERSATION_CHECKPOINT_PREFIX = '__conversation_checkpoint__:'

export function getConversationIndexId(conversationId: string): string {
  return `${CONVERSATION_INDEX_PREFIX}${conversationId}`
}

export function getConversationCheckpointId(conversationId: string): string {
  return `${CONVERSATION_CHECKPOINT_PREFIX}${conversationId}`
}

export function* recordConversationSession(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
  sessionId: string,
): Operation<void> {
  const indexId = getConversationIndexId(conversationId)
  let buffer = yield* bufferStore.get(indexId)

  if (!buffer) {
    buffer = yield* bufferStore.create(indexId)
  }

  const { tokens } = yield* buffer.read(0)
  if (tokens.includes(sessionId)) {
    return
  }

  yield* buffer.append([sessionId])
}

export function* recordConversationCheckpoint(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
  checkpointToken: string,
): Operation<void> {
  const checkpointId = getConversationCheckpointId(conversationId)
  const existing = yield* bufferStore.get(checkpointId)
  if (existing) {
    yield* bufferStore.delete(checkpointId)
  }

  const buffer = yield* bufferStore.create(checkpointId)
  yield* buffer.append([checkpointToken])
}

export function* readLatestConversationCheckpoint(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
): Operation<string | null> {
  const checkpointId = getConversationCheckpointId(conversationId)
  const buffer = yield* bufferStore.get(checkpointId)

  if (!buffer) {
    return null
  }

  const { tokens } = yield* buffer.read(0)
  return tokens[tokens.length - 1] ?? null
}

export function* resolveLatestConversationSession(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
): Operation<string | null> {
  const indexId = getConversationIndexId(conversationId)
  const buffer = yield* bufferStore.get(indexId)

  if (!buffer) {
    return null
  }

  const { tokens } = yield* buffer.read(0)

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const candidate = tokens[index]
    if (!candidate) {
      continue
    }

    const sessionBuffer = yield* bufferStore.get(candidate)
    if (sessionBuffer) {
      return candidate
    }
  }

  return null
}
