import type { Operation } from "effection";
import type { TokenBuffer, TokenBufferStore } from "@sweatpants/durable-streams";

const CONVERSATION_INDEX_PREFIX = "__conversation_index__:";
const CONVERSATION_CHECKPOINT_PREFIX = "__conversation_checkpoint__:";
const CONVERSATION_CHECKPOINT_VERSION_PREFIX = "__conversation_checkpoint_version__:";
const CHECKPOINT_POINTER_KIND = "sweatpants.conversation-checkpoint-pointer";

interface CheckpointPointer {
  readonly kind: typeof CHECKPOINT_POINTER_KIND;
  readonly sequence: number;
  readonly versionId: string;
}

interface CheckpointSlot {
  readonly id: string;
  readonly buffer: TokenBuffer<string>;
  readonly pointer: CheckpointPointer;
}

export function getConversationIndexId(conversationId: string): string {
  return `${CONVERSATION_INDEX_PREFIX}${conversationId}`;
}

/** The primary of two crash-safe pointer slots. */
export function getConversationCheckpointId(conversationId: string): string {
  return `${CONVERSATION_CHECKPOINT_PREFIX}${conversationId}`;
}

/** The secondary pointer slot used while replacing the primary slot. */
export function getConversationCheckpointAlternateId(conversationId: string): string {
  return `${getConversationCheckpointId(conversationId)}:alternate`;
}

function checkpointPointerIds(conversationId: string): readonly string[] {
  return [
    getConversationCheckpointId(conversationId),
    getConversationCheckpointAlternateId(conversationId),
  ];
}

function checkpointVersionId(conversationId: string): string {
  return `${CONVERSATION_CHECKPOINT_VERSION_PREFIX}${conversationId}:${crypto.randomUUID()}`;
}

type CheckpointPointerCandidate = {
  readonly kind: typeof CHECKPOINT_POINTER_KIND;
  readonly sequence: number;
  readonly versionId: string;
};

function isCheckpointPointerCandidate(value: unknown): value is CheckpointPointerCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate["kind"] === CHECKPOINT_POINTER_KIND &&
    Number.isSafeInteger(candidate["sequence"]) &&
    Number(candidate["sequence"]) >= 1 &&
    typeof candidate["versionId"] === "string" &&
    candidate["versionId"].startsWith(CONVERSATION_CHECKPOINT_VERSION_PREFIX)
  );
}

function parseCheckpointPointer(value: string | undefined): CheckpointPointer | null {
  if (!value) {
    return null;
  }
  try {
    const candidate: unknown = JSON.parse(value);
    if (!isCheckpointPointerCandidate(candidate)) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function* latestToken(buffer: TokenBuffer<string>): Operation<string | undefined> {
  if (buffer.readLatest) {
    return (yield* buffer.readLatest()).token;
  }
  const { tokens } = yield* buffer.read(0);
  return tokens[tokens.length - 1];
}

function* readCheckpointSlot(
  bufferStore: TokenBufferStore<string>,
  id: string,
): Operation<CheckpointSlot | null> {
  const buffer = yield* bufferStore.get(id);
  if (!buffer) {
    return null;
  }

  const complete = yield* buffer.isComplete();
  const errored = (yield* buffer.getError()) !== null;
  if (!complete || errored) {
    return null;
  }

  const pointer = parseCheckpointPointer(yield* latestToken(buffer));
  return pointer ? { id, buffer, pointer } : null;
}

function* readCheckpointSlots(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
): Operation<CheckpointSlot[]> {
  const slots: CheckpointSlot[] = [];
  for (const id of checkpointPointerIds(conversationId)) {
    const slot = yield* readCheckpointSlot(bufferStore, id);
    if (slot) {
      slots.push(slot);
    }
  }
  return slots.sort((left, right) => right.pointer.sequence - left.pointer.sequence);
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

/**
 * Persists an immutable checkpoint artifact before publishing its pointer.
 * Two pointer slots make replacement crash-safe: the old complete pointer is
 * retained until the new artifact and pointer are complete. Old artifacts and
 * pointers are compacted only after that publication point.
 */
// Crash-safe checkpoint replacement intentionally keeps publication and rollback atomic.
// fallow-ignore-next-line complexity
export function* recordConversationCheckpoint(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
  checkpointToken: string,
): Operation<void> {
  const slots = yield* readCheckpointSlots(bufferStore, conversationId);
  const latest = slots[0];
  const pointerIds = checkpointPointerIds(conversationId);
  const targetId = latest ? pointerIds.find((id) => id !== latest.id)! : pointerIds[0]!;
  const targetBuffer = yield* bufferStore.get(targetId);

  if (targetBuffer) {
    const complete = yield* targetBuffer.isComplete();
    const errored = (yield* targetBuffer.getError()) !== null;
    if (complete || errored) {
      yield* bufferStore.delete(targetId);
    } else {
      throw new Error(`Checkpoint pointer slot ${targetId} is still active`);
    }
  }

  const sequence = (latest?.pointer.sequence ?? 0) + 1;
  const versionId = checkpointVersionId(conversationId);
  let versionBuffer: TokenBuffer<string> | undefined;
  try {
    versionBuffer = yield* bufferStore.create(versionId);
    const versionWriter = yield* versionBuffer.claimWriter({
      ownerId: `conversation-checkpoint-version:${conversationId}`,
      activationEpoch: 1,
    });
    yield* versionWriter.append([checkpointToken]);
    yield* versionWriter.complete();
  } catch (error) {
    try {
      yield* bufferStore.delete(versionId);
    } catch {
      // The unreferenced artifact is safe to reap later.
    }
    throw error;
  }

  const pointer: CheckpointPointer = {
    kind: CHECKPOINT_POINTER_KIND,
    sequence,
    versionId,
  };
  try {
    const pointerBuffer = yield* bufferStore.create(targetId);
    const pointerWriter = yield* pointerBuffer.claimWriter({
      ownerId: `conversation-checkpoint-pointer:${conversationId}`,
      activationEpoch: 1,
    });
    yield* pointerWriter.append([JSON.stringify(pointer)]);
    yield* pointerWriter.complete();
  } catch (error) {
    try {
      yield* bufferStore.delete(targetId);
      yield* bufferStore.delete(versionId);
    } catch {
      // The previous pointer remains authoritative.
    }
    throw error;
  }

  // Compact only after the new pointer is complete. Cleanup is deliberately
  // best effort: a failed delete cannot invalidate the newest restore point.
  for (const old of slots) {
    try {
      yield* bufferStore.delete(old.pointer.versionId);
      yield* bufferStore.delete(old.id);
    } catch {
      // Reconciliation on the next successful update can retry cleanup.
    }
  }
}

export function* readLatestConversationCheckpoint(
  bufferStore: TokenBufferStore<string>,
  conversationId: string,
): Operation<string | null> {
  const slots = yield* readCheckpointSlots(bufferStore, conversationId);
  for (const slot of slots) {
    const version = yield* bufferStore.get(slot.pointer.versionId);
    if (!version) {
      continue;
    }
    const complete = yield* version.isComplete();
    const errored = (yield* version.getError()) !== null;
    if (!complete || errored) {
      continue;
    }
    const token = yield* latestToken(version);
    if (token !== undefined) {
      return token;
    }
  }
  return null;
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
