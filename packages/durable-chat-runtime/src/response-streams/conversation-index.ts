import type { Operation } from "effection";
import type { TokenBufferStore } from "@sweatpants/durable-streams";

const CONVERSATION_INDEX_PREFIX = "__conversation_index__:";
const CONVERSATION_CHECKPOINT_PREFIX = "__conversation_checkpoint__:";

export function getConversationIndexId(conversationId: string): string {
  return `${CONVERSATION_INDEX_PREFIX}${conversationId}`;
}

export function getConversationCheckpointId(conversationId: string): string {
  return `${CONVERSATION_CHECKPOINT_PREFIX}${conversationId}`;
}

export function* recordConversationSession(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
  sessionId: string,
): Operation<void> {
  const indexId = getConversationIndexId(conversationId);
  let buffer = yield* bufferStore.get(indexId);

  if (!buffer) {
    buffer = yield* bufferStore.create(indexId);
  }

  const { tokens } = yield* buffer.read(0);
  if (tokens.includes(sessionId)) {
    return;
  }

  const writer = yield* buffer.claimWriter({
    ownerId: `conversation-index:${conversationId}`,
    activationEpoch: 1,
  });
  yield* writer.append([sessionId]);
}

export function* recordConversationCheckpoint(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
  checkpointToken: string,
): Operation<void> {
  const checkpointId = getConversationCheckpointId(conversationId);
  let buffer = yield* bufferStore.get(checkpointId);

  // Checkpoints are an append-only version log. A new version is appended
  // atomically, so a failed write cannot delete the last valid restore point.
  // A completed pre-versioned buffer is disposable because bare-array
  // checkpoints are intentionally unsupported before production compatibility.
  if (buffer && (yield* buffer.isComplete() || (yield* buffer.getError()) !== null)) {
    yield* bufferStore.delete(checkpointId);
    buffer = null;
  }
  if (!buffer) {
    buffer = yield* bufferStore.create(checkpointId);
  }

  const { lsn } = yield* buffer.read(0);
  const writer = yield* buffer.claimWriter({
    ownerId: `conversation-checkpoint:${conversationId}`,
    activationEpoch: lsn + 1,
  });
  yield* writer.append([checkpointToken]);
}

export function* readLatestConversationCheckpoint(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
): Operation<string | null> {
  const checkpointId = getConversationCheckpointId(conversationId);
  const buffer = yield* bufferStore.get(checkpointId);

  if (!buffer) {
    return null;
  }

  const { tokens } = yield* buffer.read(0);
  return tokens[tokens.length - 1] ?? null;
}

export function* resolveLatestConversationSession(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
): Operation<string | null> {
  const indexId = getConversationIndexId(conversationId);
  const buffer = yield* bufferStore.get(indexId);

  if (!buffer) {
    return null;
  }

  const { tokens } = yield* buffer.read(0);

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const candidate = tokens[index];
    if (!candidate) {
      continue;
    }

    const sessionBuffer = yield* bufferStore.get(candidate);
    if (sessionBuffer) {
      return candidate;
    }
  }

  return null;
}
