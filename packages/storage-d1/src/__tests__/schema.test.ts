import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { domainSchemaStatements } from "../schema-sql.ts";
it("uses exactly the generated SQLite domain baseline", async () => {
  const source = await readFile(
    new URL("../../../storage-sqlite/drizzle/0000_baseline.sql", import.meta.url),
    "utf8",
  );
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim().replace(/;$/, ""))
    .filter(Boolean)
    .map((statement) =>
      statement
        .replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
        .replace("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ")
        .replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "),
    );
  expect(domainSchemaStatements).toEqual(statements);
});
