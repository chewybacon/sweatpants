import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

/** Raw SQL is limited to transaction control and read-only inspection helpers. */
describe("SQLite raw SQL allowlist", () => {
  it("contains raw execution only at reviewed adapter locations", async () => {
    const files = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts"));
    const uses: string[] = [];
    for (const file of files) {
      const lines = (await readFile(new URL(`../${file}`, import.meta.url), "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (line.includes("sql.raw(") || line.includes("client.exec(")) {
          uses.push(`${file}:${index + 1}:${line.trim()}`);
        }
      }
    }

    expect(uses).toEqual([
      'better-sqlite3.ts:95:client.exec("BEGIN IMMEDIATE");',
      'better-sqlite3.ts:97:client.exec("COMMIT");',
      'better-sqlite3.ts:101:client.exec("ROLLBACK");',
      "inspection.ts:54:sql.raw(",
      "inspection.ts:67:sql.raw(",
      "inspection.ts:79:sql.raw(",
    ]);
  });
});
