import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BetterSqliteDatabase } from "@sweatpants/storage-sqlite/better-sqlite3";
import {
  createPrimitiveChatApp,
  type PrimitiveChatOptions,
} from "@sweatpants/agent-host/primitive";
import { configureThreadMetadataStore } from "../lib/thread-metadata-store";
import { createSqliteThreadMetadataStore } from "../lib/sqlite-thread-metadata-store";
import { tools } from "./tool-definitions.ts";
import { toolEffects } from "./tool-effects.ts";

/** Node/SQLite journal host with per-tool execution placement. */
export function createLocalYoChatApplication(
  options: Pick<PrimitiveChatOptions, "database" | "model" | "execution">,
) {
  mkdirSync(dirname(options.database), { recursive: true });
  const metadata = new BetterSqliteDatabase(`${options.database}.metadata`);
  configureThreadMetadataStore(createSqliteThreadMetadataStore(metadata));
  let app: ReturnType<typeof createPrimitiveChatApp>;
  try {
    app = createPrimitiveChatApp({
      ...options,
      basePath: "/api/chat",
      program: { id: "yo-chat-local", version: "2", digest: "yo-chat-local-primitive-v2" },
      tools,
      effects: toolEffects,
      authorize: () => true,
    });
  } catch (error) {
    metadata.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    ...app,
    async inspect(): Promise<never> {
      throw new Error("The local primitive host does not expose a ProgramDriver journal");
    },
    close() {
      return (closing ??= (async () => {
        try {
          await app.close();
        } finally {
          metadata.close();
        }
      })());
    },
  };
}
