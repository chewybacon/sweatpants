import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

/** Raw SQL is limited to schema initialization, transaction control, and read-only inspection. */
describe("SQLite raw SQL allowlist", () => {
  it("contains raw execution only at reviewed adapter locations", async () => {
    const files = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts"));
    const uses: string[] = [];
    for (const file of files) {
      const lines = (await readFile(new URL(`../${file}`, import.meta.url), "utf8")).split("\n");
      for (const line of lines) {
        if (
          line.includes("sql.raw(") ||
          line.includes("client.exec(") ||
          line.trimStart().startsWith(".prepare(")
        ) {
          // Locations are reviewed as file + statement; line numbers are
          // noise that otherwise breaks on unrelated edits.
          uses.push(`${file}:${line.trim()}`);
        }
      }
    }
    uses.sort();

    expect(uses).toEqual(
      [
        "better-sqlite3.ts:.prepare(",
        'better-sqlite3.ts:client.exec("BEGIN IMMEDIATE");',
        'better-sqlite3.ts:client.exec("COMMIT");',
        'better-sqlite3.ts:client.exec("ROLLBACK");',
        "inspection.ts:sql.raw(",
        "inspection.ts:sql.raw(",
        "inspection.ts:sql.raw(",
      ].sort(),
    );
  });
});
