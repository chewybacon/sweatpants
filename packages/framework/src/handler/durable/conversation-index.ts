import type { Operation } from 'effection'
import type { TokenBufferStore } from '@sweatpants/durable-streams'

const CONVERSATION_INDEX_PREFIX = '__conversation_index__:'

export function getConversationIndexId(conversationId: string): string {
  return `${CONVERSATION_INDEX_PREFIX}${conversationId}`
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
