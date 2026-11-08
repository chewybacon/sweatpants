import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabaseRig } from "./contracts.ts";

/** Temporary file-backed database for application tables alongside journal stores.
 * Reopen only after joining all work using the old connection; this is not process-kill evidence. */
export function createSqliteDatabaseRig(): SqliteDatabaseRig {
  const directory = mkdtempSync(join(tmpdir(), "sweatpants-application-"));
  const path = join(directory, "application.sqlite");
  let database: DatabaseSync | undefined = new DatabaseSync(path);
  return {
    get database() {
      if (!database) {
        throw new Error("Database rig closed");
      }
      return database;
    },
    reopen() {
      database?.close();
      database = new DatabaseSync(path);
      return database;
    },
    close() {
      database?.close();
      database = undefined;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
