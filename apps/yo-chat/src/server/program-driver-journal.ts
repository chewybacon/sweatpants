import { call, type Operation } from "effection";
import {
  createInMemoryProgramDriverJournalStore,
  type ProgramDriverJournal,
  type ProgramDriverJournalStore,
} from "@sweatpants/framework/server";
import { createRedisDurableJournalAuthority } from "@sweatpants/crank-store-redis";
import type { RedisClientType } from "redis";
import type {
  CapabilityKeyring,
  DurableSemanticRecord,
  ResolveOperationResult,
} from "@sweatpants/session-contract";

import { getSharedRedisClient } from "@/lib/shared-redis";

/** Creates the yo-chat ProgramRuntime journal adapter over shared Redis or development memory. */
export function createYoChatProgramDriverJournalStore(
  keyring: CapabilityKeyring,
): ProgramDriverJournalStore {
  const fallback = createInMemoryProgramDriverJournalStore({
    keyring,
    journalPrefix: "yo-chat-program-driver",
  });

  return {
    *open(conversationId): Operation<ProgramDriverJournal> {
      const client = yield* call(() => getSharedRedisClient());
      if (!client) {
        return yield* fallback.open(conversationId);
      }
      return yield* createRedisProgramDriverJournalStore(client, keyring).open(conversationId);
    },
  };
}

/** Creates a ProgramRuntime journal store over a caller-owned Redis connection. */
export function createRedisProgramDriverJournalStore(
  client: RedisClientType,
  keyring: CapabilityKeyring,
): ProgramDriverJournalStore {
  return {
    *open(conversationId): Operation<ProgramDriverJournal> {
      const authority = createRedisDurableJournalAuthority(client, {
        journalId: `yo-chat-program-driver:${conversationId}`,
        journalIncarnation: "1",
        keyring,
      });
      return {
        authority,
        *openTask(request): Operation<void> {
          yield* authority.openTask(request);
        },
        *readJournal(sessionId): Operation<DurableSemanticRecord[]> {
          return yield* authority.readJournal(sessionId);
        },
        *requestCancellation(sessionId, taskId, reason): Operation<void> {
          yield* authority.requestCancellation(sessionId, taskId, reason);
        },
        *resolvePending(request): Operation<ResolveOperationResult> {
          const capability = yield* authority.resolutionCapability(
            request.sessionId,
            request.taskId,
            request.pullId,
          );
          return yield* authority.resolve({
            capability,
            audience: request.audience,
            outcome: request.outcome,
          });
        },
      };
    },
  };
}
