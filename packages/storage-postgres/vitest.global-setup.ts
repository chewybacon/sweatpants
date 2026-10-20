/**
 * Starts (or reuses) the Dockerized Postgres test backend and exports the
 * connection string for test workers via `process.env.SWEATPANTS_DATABASE_URL`.
 */
export default async function globalSetup() {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/ensure-test-postgres.mjs"], {
    encoding: "utf8",
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Postgres test harness failed:\n${result.stdout}\n${result.stderr}`);
  }
  const found = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("postgres://"));
  if (!found) {
    throw new Error("Postgres test harness did not return its database URL");
  }
  process.env.SWEATPANTS_DATABASE_URL = found;
}
