type LiveEffectCancellation = {
  readonly cancel: (reason?: string) => void;
};

const liveEffects = new Map<string, LiveEffectCancellation>();

function key(sessionId: string, taskId: string, pullId: string, attemptId: string): string {
  return `${sessionId}\u0000${taskId}\u0000${pullId}\u0000${attemptId}`;
}

/**
 * Registers an activation-local effect cancellation bridge. The returned release
 * function is lexical runtime state and MUST NOT be persisted.
 */
export function registerLiveDurableEffect(
  sessionId: string,
  taskId: string,
  pullId: string,
  attemptId: string,
  cancel: (reason?: string) => void,
): () => void {
  const effectKey = key(sessionId, taskId, pullId, attemptId);
  const registration = { cancel };
  liveEffects.set(effectKey, registration);
  return () => {
    if (liveEffects.get(effectKey) === registration) {
      liveEffects.delete(effectKey);
    }
  };
}

/** Signals every attached attempt for one pull without exposing its controller. */
export function signalLiveDurableEffect(
  sessionId: string,
  taskId: string,
  pullId: string,
  reason?: string,
): boolean {
  const prefix = `${sessionId}\u0000${taskId}\u0000${pullId}\u0000`;
  let signalled = false;
  for (const [effectKey, registration] of liveEffects) {
    if (effectKey.startsWith(prefix)) {
      signalled = true;
      registration.cancel(reason);
    }
  }
  return signalled;
}

/** Runtime-only settleability probe used when cancellation is accepted locally. */
export function hasLiveDurableEffect(sessionId: string, taskId: string, pullId: string): boolean {
  const prefix = `${sessionId}\u0000${taskId}\u0000${pullId}\u0000`;
  return [...liveEffects.keys()].some((effectKey) => effectKey.startsWith(prefix));
}
