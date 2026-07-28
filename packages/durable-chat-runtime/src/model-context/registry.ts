export interface PrivateModelContextRecord {
  threadId: string;
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
}

const recordsByThreadId = new Map<string, PrivateModelContextRecord>();

export function resetPrivateModelContextRegistry(): void {
  recordsByThreadId.clear();
}

export function resolvePrivateSystemPrompt(
  threadId: string,
  requestedSystemPrompt: string | undefined,
): string | undefined {
  const existing = recordsByThreadId.get(threadId);
  if (existing?.systemPrompt) {
    if (requestedSystemPrompt && requestedSystemPrompt !== existing.systemPrompt) {
      recordsByThreadId.set(threadId, {
        ...existing,
        updatedAt: Date.now(),
      });
    }
    return existing.systemPrompt;
  }

  if (!requestedSystemPrompt) {
    return undefined;
  }

  const now = Date.now();
  recordsByThreadId.set(threadId, {
    threadId,
    systemPrompt: requestedSystemPrompt,
    createdAt: now,
    updatedAt: now,
  });
  return requestedSystemPrompt;
}

export function deletePrivateModelContext(threadId: string): void {
  recordsByThreadId.delete(threadId);
}
