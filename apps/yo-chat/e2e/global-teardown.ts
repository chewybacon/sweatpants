import { rm } from "node:fs/promises";
import { basename, dirname } from "node:path";

export default async function globalTeardown(): Promise<void> {
  const databasePath = process.env["SWEATPANTS_DB_PATH"];
  if (!databasePath) {
    return;
  }
  const root = dirname(databasePath);
  if (!basename(root).startsWith("yo-chat-e2e-")) {
    throw new Error(`Refusing to remove non-E2E storage directory: ${root}`);
  }
  await rm(root, { recursive: true, force: true });
}
