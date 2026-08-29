import { fileURLToPath } from "node:url";
import { chatStorageFromEnv, type ChatStorageConfig } from "@sweatpants/agent-host/server";

/** Default on-disk location of the yo-chat authority database. */
const YO_CHAT_DEFAULT_DB_URL = new URL("../../.data/yo-chat.sqlite", import.meta.url);

export function yoChatDefaultDbPath(): string {
  return fileURLToPath(YO_CHAT_DEFAULT_DB_URL);
}

/** Resolves yo-chat authority storage from the standard environment contract. */
export function createYoChatStorageConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ChatStorageConfig {
  return chatStorageFromEnv({ defaultPath: YO_CHAT_DEFAULT_DB_URL, env: environment });
}
