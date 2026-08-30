// Type-level pin for the author-guide example: a caller's mixed-schema ORM
// (kernel tables plus co-tenant tables) is accepted by the client façade.
// Constructing the client is the assertion; nothing runs at runtime.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expectTypeOf, it } from "vitest";
import { createChatStorageClient, type ChatStorageClient } from "../client.ts";
import { sqliteSchema } from "../schema.ts";

const myTable = sqliteTable("my_table", { id: text("id").primaryKey() });
const mixed = drizzle(new Database(":memory:"), {
  schema: { ...sqliteSchema, myTable },
});

describe("client façade over a caller's mixed-schema ORM", () => {
  it("accepts the doc example without casts", () => {
    const client = createChatStorageClient(mixed);
    expectTypeOf(client).toEqualTypeOf<ChatStorageClient>();
  });
});
