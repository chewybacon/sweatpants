import type { D1Database } from "@cloudflare/workers-types";
import { domainSchemaStatements } from "./schema-sql.ts";
const statements = [
  ...domainSchemaStatements,
  `CREATE TABLE IF NOT EXISTS sp_d1_meta (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sp_d1_payloads (collection TEXT NOT NULL,key TEXT NOT NULL,parts INTEGER NOT NULL CHECK(parts>0),payload_bytes INTEGER CHECK(payload_bytes>=0),PRIMARY KEY(collection,key))`,
  `CREATE TABLE IF NOT EXISTS sp_d1_payload_chunks (collection TEXT NOT NULL,key TEXT NOT NULL,part INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(collection,key,part))`,
  `INSERT INTO sp_d1_meta(id,token) VALUES(1,'initial') ON CONFLICT(id) DO NOTHING`,
];
/** Creates the current domain schema. Reset prerelease databases when the baseline changes. */
export async function initializeD1Storage(database: D1Database): Promise<void> {
  const session = database.withSession("first-primary");
  await session.batch(statements.map((sql) => session.prepare(sql)));
}
