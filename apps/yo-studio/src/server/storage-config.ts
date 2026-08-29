import { fileURLToPath } from "node:url";
import { chatStorageFromEnv, type ChatStorageConfig } from "@sweatpants/agent-host/server";

const YO_STUDIO_DEFAULT_DB_URL = new URL("../../.data/yo-studio.sqlite", import.meta.url);

/** Default on-disk location of the yo-studio authority database. */
export const YO_STUDIO_DEFAULT_DB_PATH = fileURLToPath(YO_STUDIO_DEFAULT_DB_URL);

/** Resolves yo-studio authority storage from the standard environment contract. */
export function createYoStudioStorageConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ChatStorageConfig {
  return chatStorageFromEnv({ defaultPath: YO_STUDIO_DEFAULT_DB_URL, env: environment });
}
