import type { D1Database } from "@cloudflare/workers-types";
import { DurableKernelError } from "@sweatpants/durable-storage-kernel";

const statements = [
  `CREATE TABLE IF NOT EXISTS sp_d1_meta (id INTEGER PRIMARY KEY CHECK(id = 1), format INTEGER NOT NULL, token TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sp_d1_records (
    collection TEXT NOT NULL, key TEXT NOT NULL, revision TEXT, fence TEXT, fingerprint TEXT,
    byte_length INTEGER NOT NULL, PRIMARY KEY(collection, key))`,
  `CREATE TABLE IF NOT EXISTS sp_d1_chunks (
    collection TEXT NOT NULL, key TEXT NOT NULL, part INTEGER NOT NULL, value BLOB NOT NULL,
    PRIMARY KEY(collection, key, part), FOREIGN KEY(collection, key) REFERENCES sp_d1_records(collection, key))`,
  `CREATE TABLE IF NOT EXISTS sp_d1_aliases (
    collection TEXT NOT NULL, alias TEXT NOT NULL, key TEXT NOT NULL,
    PRIMARY KEY(collection, alias), FOREIGN KEY(collection, key) REFERENCES sp_d1_records(collection, key))`,
  `CREATE TABLE IF NOT EXISTS sp_d1_positions (
    collection TEXT NOT NULL, index_name TEXT NOT NULL, scope TEXT NOT NULL,
    position TEXT NOT NULL, digits INTEGER NOT NULL, key TEXT NOT NULL,
    PRIMARY KEY(collection, index_name, scope, position, key),
    FOREIGN KEY(collection, key) REFERENCES sp_d1_records(collection, key))`,
  `CREATE INDEX IF NOT EXISTS sp_d1_scan ON sp_d1_positions(collection, index_name, scope, digits, position, key)`,
  `INSERT INTO sp_d1_meta(id, format, token) VALUES (1, 1, 'initial') ON CONFLICT(id) DO NOTHING`,
];

/** Initial schema only; incompatible prerelease data must be reset explicitly. */
export async function initializeD1Storage(database: D1Database): Promise<void> {
  const session = database.withSession("first-primary");
  await session.batch(statements.map((sql) => session.prepare(sql)));
  const row = await session
    .prepare("SELECT format FROM sp_d1_meta WHERE id = 1")
    .first<{ format: number }>();
  if (row?.format !== 1)
    throw new DurableKernelError(
      "durable_kernel_schema_incompatible",
      "Unsupported D1 journal format; reset the selected D1 database before reuse",
    );
}
