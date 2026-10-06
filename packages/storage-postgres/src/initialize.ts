import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresSchema } from "./schema.ts";
import { fileURLToPath } from "node:url";

/** Applies generated Drizzle SQL. Prerelease baselines may be regenerated after resetting data. */
export async function initializePostgresStorage(
  database: NodePgDatabase<PostgresSchema>,
): Promise<void> {
  await database.transaction(async (transaction) => {
    // Fresh databases can have concurrent initializers before any domain authority exists.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('sp:schema', 0))`);
    await migrate(transaction, {
      migrationsFolder: fileURLToPath(new URL("../drizzle/", import.meta.url)),
    });
  });
}
