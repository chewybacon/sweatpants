import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRuntime } from "@sweatpan.ts/runtime-effection";
import { createCardChatHandlers } from "./card-chat-handlers.ts";
import { createModelSampling } from "./card-chat-model.ts";
const runtime = createRuntime();
export const cardChatHandlers = createCardChatHandlers(
  runtime,
  () => {
    const path = resolve(process.env.YO_CHAT_DATABASE ?? "data/yo-chat-v2.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    return new DatabaseSync(path);
  },
  (publish) => createModelSampling(runtime, publish),
);
