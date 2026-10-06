import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { D1Database, DurableObjectNamespace } from "@cloudflare/workers-types";
import { unstable_dev } from "wrangler";
import { expect, test } from "vitest";
import { withWranglerEnv } from "../../index.js";

test("CLI seeds D1 through imported env, shares persisted state, and releases bindings after failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-task-d1-"));
  const config = join(directory, "wrangler.jsonc");
  const persistTo = join(directory, "state");
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      config,
      JSON.stringify({
        name: "task-d1",
        compatibility_date: "2026-10-05",
        d1_databases: [{ binding: "DB", database_name: "tasks", database_id: "tasks" }],
      }),
    );
    const script = join(directory, "seed.mts");
    await writeFile(
      join(directory, "dependency.ts"),
      `
      import { env } from "cloudflare:workers";
      export async function seed(value: string): Promise<void> {
        await env.DB.exec("CREATE TABLE seeds (value TEXT)");
        await env.DB.prepare("INSERT INTO seeds VALUES (?)").bind(value).run();
      }
    `,
    );
    await writeFile(
      script,
      `
      import { seed } from "./dependency.ts";
      export default async ({ args }: { args: string[] }): Promise<void> => {
        await seed(args[0]);
      }
    `,
    );
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../../../dist/cli.js", import.meta.url)),
      "--config",
      config,
      "--persist-to",
      persistTo,
      script,
      "--a-task-flag",
    ]);
    await withWranglerEnv<{ DB: D1Database }, void>({ config, persistTo }, async ({ DB }) => {
      expect(await DB.prepare("SELECT value FROM seeds").first("value")).toBe("--a-task-flag");
      throw new Error("task failed");
    }).then(
      () => {
        throw new Error("expected failure");
      },
      (error: Error) => {
        expect(error.message).toBe("task failed");
      },
    );
    await withWranglerEnv<{ DB: D1Database }, void>({ config, persistTo }, async ({ DB }) => {
      expect(await DB.prepare("SELECT COUNT(*) AS count FROM seeds").first("count")).toBe(1);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("tasks reach an actual Durable Object in a separate local Wrangler Worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-task-do-"));
  const workerConfig = join(directory, "worker.jsonc");
  const taskConfig = join(directory, "task.jsonc");
  await writeFile(
    workerConfig,
    JSON.stringify({
      name: "task-counter-worker",
      compatibility_date: "2026-10-05",
      durable_objects: { bindings: [{ name: "COUNTERS", class_name: "Counter" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
    }),
  );
  await writeFile(
    taskConfig,
    JSON.stringify({
      name: "counter-maintenance",
      compatibility_date: "2026-10-05",
      durable_objects: {
        bindings: [{ name: "COUNTERS", class_name: "Counter", script_name: "task-counter-worker" }],
      },
    }),
  );
  const worker = await unstable_dev(
    fileURLToPath(new URL("../fixtures/counter.js", import.meta.url)),
    {
      config: workerConfig,
      local: true,
      port: 0,
      persist: false,
      experimental: { disableExperimentalWarning: true },
    },
  );
  try {
    await withWranglerEnv<{ COUNTERS: DurableObjectNamespace }, void>(
      { config: taskConfig, persistTo: join(directory, "state") },
      async ({ COUNTERS }) => {
        const counter = COUNTERS.get(COUNTERS.idFromName("demo"));
        // Wrangler publishes its dev registry asynchronously after the HTTP server is ready.
        await expect
          .poll(async () =>
            (await counter.fetch("https://counter/", { method: "POST", body: "10" })).text(),
          )
          .toBe("10");
      },
    );
    await withWranglerEnv<{ COUNTERS: DurableObjectNamespace }, void>(
      { config: taskConfig, persistTo: join(directory, "state") },
      async ({ COUNTERS }) => {
        const counter = COUNTERS.get(COUNTERS.idFromName("demo"));
        expect(await (await counter.fetch("https://counter/")).text()).toBe("10");
      },
    );
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
