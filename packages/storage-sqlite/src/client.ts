import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import type { Json } from "@sweatpants/foundation";
import { createSqliteReaderBinding, type BetterSqliteBinding } from "./better-sqlite3.ts";
import { spConversationHeads, spConversationTerminalSegments, sqliteSchema } from "./schema.ts";

/**
 * A drizzle instance typed against the authority schema. Applications create
 * their own over a binding they own, or use the kernel handle's `database`,
 * or a reader's `database`.
 */
export type ChatStorageDatabase = BetterSQLite3Database<typeof sqliteSchema>;

/** Curated thread summary derived from `sp_conversation_heads`. */
export interface ThreadSummary {
  readonly id: string;
  readonly state: string;
  readonly updatedAt: number;
}

/** One transcript entry with its absolute position in the conversation. */
export interface TranscriptEntry {
  readonly position: number;
  readonly entry: Json;
}

export interface TranscriptPage {
  readonly entries: readonly TranscriptEntry[];
  /** Position to pass as `after` for the next page; `null` when exhausted. */
  readonly nextAfter: number | null;
}

/**
 * Read-only access to authority data. There is deliberately no mutation
 * surface: authority writes belong to kernel operations only.
 */
export interface ChatStorageClient {
  readonly threads: {
    /** Non-deleted threads, newest first. */
    list(): ThreadSummary[];
    /** One thread summary, including soft-deleted rows; `null` when absent. */
    get(conversationId: string): ThreadSummary | null;
  };
  readonly transcript: {
    /**
     * Terminal-history entries for a conversation in ascending position
     * order, starting strictly after `after`.
     */
    page(conversationId: string, options?: { after?: number; limit?: number }): TranscriptPage;
  };
}

const DEFAULT_TRANSCRIPT_LIMIT = 100;

function toNumber(value: string | number | bigint): number {
  return typeof value === "number" ? value : Number(value);
}

/**
 * Builds a read-only query surface over controlled authority data. The same
 * client works over a kernel handle's `database`, a reader's `database`, or
 * any equivalent drizzle instance the application built itself.
 */
export function createChatStorageClient(database: ChatStorageDatabase): ChatStorageClient {
  const headColumns = {
    id: spConversationHeads.conversationId,
    state: spConversationHeads.state,
    updatedAt: spConversationHeads.updatedAt,
  };
  const toSummary = (row: { id: string; state: string; updatedAt: string | number | bigint }) => ({
    id: row.id,
    state: row.state,
    updatedAt: toNumber(row.updatedAt),
  });

  return {
    threads: {
      list() {
        const rows = database
          .select(headColumns)
          .from(spConversationHeads)
          .where(isNull(spConversationHeads.deletedAt))
          .orderBy(desc(spConversationHeads.updatedAt))
          .all();
        return rows.map(toSummary);
      },
      get(conversationId) {
        const row = database
          .select(headColumns)
          .from(spConversationHeads)
          .where(eq(spConversationHeads.conversationId, conversationId))
          .get();
        return row ? toSummary(row) : null;
      },
    },
    transcript: {
      page(conversationId, options = {}) {
        const after = options.after ?? -1;
        const limit = options.limit ?? DEFAULT_TRANSCRIPT_LIMIT;
        if (limit <= 0) {
          return { entries: [], nextAfter: null };
        }
        // Push the cursor into the scan: segments entirely at or before
        // `after` are skipped, so page cost tracks the page, not the
        // conversation length.
        const segments = database
          .select({
            firstPosition: spConversationTerminalSegments.firstPosition,
            entriesJson: spConversationTerminalSegments.entriesJson,
          })
          .from(spConversationTerminalSegments)
          .where(
            after >= 0
              ? and(
                  eq(spConversationTerminalSegments.conversationId, conversationId),
                  gt(spConversationTerminalSegments.lastPosition, String(after)),
                )
              : eq(spConversationTerminalSegments.conversationId, conversationId),
          )
          .orderBy(asc(spConversationTerminalSegments.firstPosition))
          .all();

        const entries: TranscriptEntry[] = [];
        let sawEntryBeyondLimit = false;
        outer: for (const segment of segments) {
          const parsed = JSON.parse(segment.entriesJson) as Json[];
          const first = toNumber(segment.firstPosition);
          for (let offset = 0; offset < parsed.length; offset += 1) {
            const position = first + offset;
            if (position <= after) {
              continue;
            }
            if (entries.length >= limit) {
              sawEntryBeyondLimit = true;
              break outer;
            }
            entries.push({ position, entry: parsed[offset]! });
          }
        }
        const last = entries.at(-1);
        return {
          entries,
          nextAfter: sawEntryBeyondLimit && last ? last.position : null,
        };
      },
    },
  };
}

export interface ChatStorageReader {
  readonly database: ChatStorageDatabase;
  /** Closes the reader; it is kernel-created, so the reader owns it. */
  close(): void;
}

/**
 * Opens a read-only binding for out-of-process tools: the file must exist,
 * no migrations run, no WAL is set, and the driver refuses writes.
 */
export function openChatStorageReader(path: string): ChatStorageReader {
  const binding: BetterSqliteBinding = createSqliteReaderBinding(path);
  return {
    database: drizzle(binding, { schema: sqliteSchema }),
    close() {
      binding.close();
    },
  };
}
