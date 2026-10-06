import type Database from "better-sqlite3";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Yo-chat's co-tenant table. It lives beside the kernel's reserved `sp_`
 * namespace in the same SQLite file; the kernel neither knows about nor
 * provisions it (the application owns its own schema).
 */
export const threadMetadata = sqliteTable(
  "thread_metadata",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    title: text("title").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastMessagePreview: text("last_message_preview").notNull(),
    messageCount: integer("message_count").notNull(),
  },
  (table) => [
    index("idx_thread_metadata_namespace_updated").on(table.namespace, table.updatedAt, table.id),
  ],
);

/**
 * Creates yo-chat's co-tenant schema if absent. Idempotent; runs on the
 * application's own binding at startup, never through the kernel.
 */
export function ensureThreadMetadataSchema(binding: Database.Database): void {
  binding.exec(`
    CREATE TABLE IF NOT EXISTS "thread_metadata" (
      "id" text PRIMARY KEY NOT NULL,
      "namespace" text NOT NULL,
      "title" text NOT NULL,
      "created_at" integer NOT NULL,
      "updated_at" integer NOT NULL,
      "last_message_preview" text NOT NULL,
      "message_count" integer NOT NULL
    );
  `);
  binding.exec(
    `CREATE INDEX IF NOT EXISTS idx_thread_metadata_updated_id ON thread_metadata(updated_at DESC, id DESC)`,
  );
  binding.exec(
    `CREATE INDEX IF NOT EXISTS "idx_thread_metadata_namespace_updated"
       ON "thread_metadata" ("namespace", "updated_at" DESC, "id" DESC);`,
  );
}
