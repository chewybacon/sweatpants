export const STUDIO_CONVERSATION_KEY = "yo-studio:conversation-id";

interface ConversationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getOrCreateConversationId(
  storage: ConversationStorage,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const existing = storage.getItem(STUDIO_CONVERSATION_KEY)?.trim();
  if (existing) {
    return existing;
  }
  return replaceConversationId(storage, createId);
}

export function replaceConversationId(
  storage: ConversationStorage,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const next = createId();
  storage.setItem(STUDIO_CONVERSATION_KEY, next);
  return next;
}
