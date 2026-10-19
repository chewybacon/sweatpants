import { readFile, writeFile } from "node:fs/promises";
const source = new URL("../../storage-sqlite/drizzle/0000_baseline.sql", import.meta.url);
const statements = (await readFile(source, "utf8"))
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim().replace(/;$/, ""))
  .filter(Boolean)
  .map((statement) =>
    statement
      .replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
      .replace("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ")
      .replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "),
  );
await writeFile(
  new URL("../src/schema-sql.ts", import.meta.url),
  `// Generated from storage-sqlite/drizzle/0000_baseline.sql. Run pnpm db:generate.\nexport const domainSchemaStatements = ${JSON.stringify(statements, null, 2)};\n`,
);
