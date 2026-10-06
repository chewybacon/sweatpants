import type { D1Database } from "@cloudflare/workers-types";

const statements = [
  `CREATE TABLE IF NOT EXISTS sp_d1_meta (id INTEGER PRIMARY KEY CHECK(id = 1), token TEXT NOT NULL)`,
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
  `INSERT INTO sp_d1_meta(id, token) VALUES (1, 'initial') ON CONFLICT(id) DO NOTHING`,
];

/** Creates the current prerelease schema. Reset local data when the schema changes. */
export async function initializeD1Storage(database: D1Database): Promise<void> {
  const session = database.withSession("first-primary");
  await session.batch(statements.map((sql) => session.prepare(sql)));
}
