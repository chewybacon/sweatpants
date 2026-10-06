import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";

/** Applies generated Drizzle SQL. Prerelease baselines may be regenerated after resetting data. */
export function initializeSqliteStorage(client: Database.Database): void {
  migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL("../drizzle/", import.meta.url)),
  });
}
