import type { D1Database } from "@cloudflare/workers-types";
import type { ChatStorageConfig } from "@sweatpants/agent-host/server";
import { createMemoryDurableKernel } from "@sweatpants/durable-storage-kernel/memory";
import { createKernelConversationStore } from "@sweatpants/history-store/repository";
import { createKernelExecutionStore } from "@sweatpants/journal-authority/store-repository";
import { openD1Storage } from "@sweatpants/storage-d1";
import { openPostgresStorage } from "@sweatpants/storage-postgres/pg-binding";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import { run } from "effection";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestPostgres } from "./postgres.ts";

export const storageVariants = ["memory", "sqlite", "postgres", "d1"] as const;
export type StorageVariant = (typeof storageVariants)[number];
export interface StorageRig {
  open(): Promise<{ storage: ChatStorageConfig; close(): Promise<void> }>;
  close(): Promise<void>;
}

/** Own backing state independently of each application/connection generation. */
async function createStorageRig(variant: StorageVariant): Promise<StorageRig> {
  switch (variant) {
    case "memory": {
      const kernel = createMemoryDurableKernel();
      return {
        async open() {
          return {
            storage: {
              kind: "custom",
              conversationStore: createKernelConversationStore(kernel),
              executionStore: createKernelExecutionStore(kernel),
            },
            async close() {},
          };
        },
        async close() {},
      };
    }
    case "sqlite": {
      const directory = await mkdtemp(join(tmpdir(), "acceptance-sqlite-"));
      return {
        async open() {
          const handle = await run(() =>
            openBetterSqliteStorage(join(directory, "authority.sqlite"), { initialize: true }),
          );
          return {
            storage: { kind: "custom", ...handle.storage },
            close: () => run(() => handle.close()),
          };
        },
        close: () => rm(directory, { recursive: true, force: true }),
      };
    }
    case "postgres": {
      const postgres = await openTestPostgres();
      return {
        async open() {
          const handle = await openPostgresStorage({ connectionString: postgres.connectionString });
          return {
            storage: { kind: "custom", ...handle.storage },
            close: () => run(() => handle.close()),
          };
        },
        close: () => postgres.close(),
      };
    }
    case "d1": {
      const worker = new Miniflare({
        workers: [
          {
            config: {
              name: "acceptance-storage",
              compatibilityDate: "2026-10-05",
              manifest: {
                mainModule: "index.js",
                modules: {
                  "index.js": {
                    type: "esm",
                    contents: "export default {fetch(){return new Response('ok')}}",
                  },
                },
              },
              env: { JOURNAL: { type: "d1", id: "acceptance" } },
            },
          },
        ],
      });
      try {
        // Miniflare's host proxy implements the worker D1 binding contract.
        const database = (await worker.getD1Database("JOURNAL")) as unknown as D1Database;
        return {
          async open() {
            const storage = await run(() => openD1Storage(database));
            return { storage, async close() {} };
          },
          close: () => worker.dispose(),
        };
      } catch (error) {
        await worker.dispose();
        throw error;
      }
    }
  }
}

/** Close every acquired connection before removing its backing service, including failed setup. */
export async function openStorageRig(variant: StorageVariant): Promise<StorageRig> {
  const backing = await createStorageRig(variant);
  const connections = new Set<() => Promise<void>>();
  return {
    async open() {
      const connection = await backing.open();
      let closed = false;
      const close = async () => {
        if (!closed) {
          closed = true;
          await connection.close();
          connections.delete(close);
        }
      };
      connections.add(close);
      return { storage: connection.storage, close };
    },
    async close() {
      const results = await Promise.allSettled([...connections].map((close) => close()));
      await backing.close();
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Storage rig cleanup failed",
        );
      }
    },
  };
}
