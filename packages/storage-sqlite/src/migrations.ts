import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Filesystem location of the checked-in drizzle-kit migration bundle.
 *
 * Resolved from the module URL in normal node contexts and from the real
 * package root when the module URL is not a file path (transformed test
 * environments, bundles).
 */
function resolveMigrationFolder(): string {
  try {
    const url = new URL("../drizzle/", import.meta.url);
    if (url.protocol === "file:") {
      return fileURLToPath(url);
    }
  } catch {
    // Non-file module URL — fall through to package resolution.
  }
  const require = createRequire(join(process.cwd(), "package.json"));
  const packageJson = require.resolve("@sweatpants/storage-sqlite/package.json");
  return join(dirname(packageJson), "drizzle");
}

export const sqliteMigrationFolder = resolveMigrationFolder();
