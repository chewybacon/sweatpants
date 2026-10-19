#!/usr/bin/env node
/**
 * Ensures a disposable Postgres 17 container is running for tests.
 *
 * Reuses `sweatpants-pg-test` across runs. The `sweatpants_test` database is
 * recreated on every invocation so suites start from a clean schema state.
 * Environment overrides:
 *   SWEATPANTS_TEST_DATABASE_URL — use an existing Postgres, skip Docker
 */
import { execFileSync, spawnSync } from "node:child_process";

const CONTAINER = "sweatpants-pg-test";
const PORT = 55432;
const URL =
  process.env.SWEATPANTS_TEST_DATABASE_URL ??
  `postgres://postgres:postgres@localhost:${PORT}/postgres`;

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...options });
}

function dockerRun(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

function isRunning() {
  const result = docker(["ps", "--filter", `name=${CONTAINER}`, "--format", "{{.Names}}"]);
  return result.status === 0 && result.stdout.includes(CONTAINER);
}

function exists() {
  const result = docker(["ps", "-a", "--filter", `name=${CONTAINER}`, "--format", "{{.Names}}"]);
  return result.status === 0 && result.stdout.includes(CONTAINER);
}

async function main() {
  const usingExternal = Boolean(process.env.SWEATPANTS_TEST_DATABASE_URL);
  if (!usingExternal) {
    if (!isRunning()) {
      if (exists()) {
        dockerRun(["start", CONTAINER]);
      } else {
        dockerRun([
          "run",
          "-d",
          "--name",
          CONTAINER,
          "-e",
          "POSTGRES_PASSWORD=postgres",
          "-e",
          "POSTGRES_DB=sweatpants",
          "-p",
          `${PORT}:5432`,
          "postgres:17",
        ]);
      }
    }
  }

  const { Client } = await import("pg");
  let admin;
  const deadline = Date.now() + 30_000;
  for (;;) {
    // A pg Client cannot reconnect after a failed attempt during startup.
    admin = new Client({ connectionString: URL });
    try {
      await admin.connect();
      break;
    } catch (error) {
      await admin.end();
      if (Date.now() > deadline) {
        console.error(`Postgres test harness could not reach ${URL}: ${error.message}`);
        process.exit(2);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    // Recreate the test database so every run starts from an empty schema.
    await admin.query(`DROP DATABASE IF EXISTS sweatpants_test WITH (FORCE)`);
    await admin.query(`CREATE DATABASE sweatpants_test`);
  } finally {
    await admin.end();
  }

  const connectionString = usingExternal
    ? URL.replace(/\/postgres$/, "/sweatpants_test")
    : `postgres://postgres:postgres@localhost:${PORT}/sweatpants_test`;
  process.env.SWEATPANTS_DATABASE_URL = connectionString;
  console.log(`Postgres test harness ready: ${connectionString}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
