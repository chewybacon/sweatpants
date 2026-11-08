import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRuntime } from "@sweatpan.ts/runtime-effection";
import { createCardHandlers } from "./card-handlers.ts";

// This deployment adapter is Node-local. Each request opens a fresh connection;
// no module singleton holds a database or a live workflow across HMR/shutdown.
export const cardHandlers = createCardHandlers(createRuntime(), () => {
  const path = resolve(process.env.YO_CHAT_DATABASE ?? "data/yo-chat-v2.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
});
