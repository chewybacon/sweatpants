import { fileURLToPath } from "node:url";

/** Filesystem location of the checked-in drizzle-kit migration bundle. */
export const sqliteMigrationFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));
