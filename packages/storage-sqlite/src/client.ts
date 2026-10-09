import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
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
    /** Non-deleted threads, newest first. Pass the last summary as before for the next page. */
    list(options?: { limit?: number; before?: { updatedAt: number; id: string } }): ThreadSummary[];
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
const MAX_PAGE_LIMIT = 1000;

function pageLimit(value = DEFAULT_TRANSCRIPT_LIMIT): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PAGE_LIMIT) {
    throw new RangeError(`Page limit must be an integer between 0 and ${MAX_PAGE_LIMIT}`);
  }
  return value;
}

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
      list(options = {}) {
        const limit = pageLimit(options.limit);
        const rows = database
          .select(headColumns)
          .from(spConversationHeads)
          .where(
            and(
              isNull(spConversationHeads.deletedAt),
              options.before
                ? sql`(${spConversationHeads.updatedAt}, ${spConversationHeads.conversationId}) < (${options.before.updatedAt}, ${options.before.id})`
                : undefined,
            ),
          )
          .orderBy(desc(spConversationHeads.updatedAt), desc(spConversationHeads.conversationId))
          .limit(limit)
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
        const limit = pageLimit(options.limit);
        if (!Number.isSafeInteger(after) || after < -1) {
          throw new RangeError("Transcript cursor must be a safe integer at least -1");
        }
        if (limit <= 0) {
          return { entries: [], nextAfter: null };
        }
        const table = spConversationTerminalSegments;
        const columns = { firstPosition: table.firstPosition, entriesJson: table.entriesJson };
        // Seek the single segment containing the cursor, then seek forward.
        // Filtering last_position while ordering first_position scanned old history.
        const containing =
          after >= 0
            ? database
                .select(columns)
                .from(table)
                .where(
                  and(
                    eq(table.conversationId, conversationId),
                    lte(table.firstPosition, String(after)),
                  ),
                )
                .orderBy(desc(table.firstPosition))
                .limit(1)
                .get()
            : undefined;
        const following = database
          .select(columns)
          .from(table)
          .where(
            and(
              eq(table.conversationId, conversationId),
              after >= 0 ? gt(table.firstPosition, String(after)) : undefined,
            ),
          )
          .orderBy(asc(table.firstPosition))
          .limit(limit + 1)
          .all();
        const segments = containing ? [containing, ...following] : following;

        const entries: TranscriptEntry[] = [];
        let sawEntryBeyondLimit = false;
        outer: for (const segment of segments) {
          const parsed = segment.entriesJson;
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
 * no initialization runs, no WAL is set, and the driver refuses writes.
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
