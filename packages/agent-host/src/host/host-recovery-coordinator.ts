import { CrankError } from "@sweatpants/durable-execution";
import { call, race, type Operation } from "effection";

import {
  type DurableJournalAuthorityService,
  type RecoverableSession,
} from "@sweatpants/session-contract";

export interface StartupRecoveryOptions {
  readonly maxSessions?: number;
  readonly activate: (session: RecoverableSession) => Operation<void>;
}

/** Bounded one-shot recovery used after process restart; continuous polling is deferred. */
export function* recoverKnownWorkOnStartup(
  authority: DurableJournalAuthorityService,
  options: StartupRecoveryOptions,
): Operation<{ attempted: string[]; failed: string[] }> {
  const sessions = (yield* authority.recoverableSessions()).slice(0, options.maxSessions ?? 100);
  const attempted: string[] = [];
  const failed: string[] = [];
  for (const session of sessions) {
    attempted.push(session.sessionId);
    try {
      yield* options.activate(session);
    } catch {
      failed.push(session.sessionId);
    }
  }
  return { attempted, failed };
}

/** Owns activation scopes so warm shutdown stops admission and aborts unfinished work. */
export type HostRecoveryCoordinator = {
  run<T>(sessionId: string, operation: Operation<T>): Operation<T>;
  shutdown(): Operation<{ unfinishedSessionIds: string[] }>;
  accepting(): boolean;
};

export function createHostRecoveryCoordinator(): HostRecoveryCoordinator {
  const active = new Map<string, AbortController>();
  let accepting = true;
  return {
    *run<T>(sessionId: string, operation: Operation<T>): Operation<T> {
      if (!accepting) {
        throw new CrankError("host_shutting_down");
      }
      const controller = new AbortController();
      active.set(sessionId, controller);
      try {
        return yield* race([
          operation,
          (function* (): Operation<T> {
            yield* call(
              () =>
                new Promise<void>((resolve) =>
                  controller.signal.addEventListener("abort", () => resolve(), { once: true }),
                ),
            );
            throw new CrankError("host_shutting_down", "Host activation scope was aborted");
          })(),
        ]);
      } finally {
        active.delete(sessionId);
      }
    },
    *shutdown(): Operation<{ unfinishedSessionIds: string[] }> {
      accepting = false;
      const unfinishedSessionIds = [...active.keys()].sort();
      for (const controller of active.values()) {
        controller.abort();
      }
      return { unfinishedSessionIds };
    },
    accepting() {
      return accepting;
    },
  };
}
