import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRuntime } from "@sweatpan.ts/runtime-effection";
import { createCardChatHandlers } from "./card-chat-handlers.ts";
import { createModelSampling } from "./card-chat-model.ts";
import { createDemoHandlers } from "./chat-handlers.ts";
import { flightDemo } from "./flight-chat-program.ts";
const runtime = createRuntime();
const openDatabase = () => {
  const path = resolve(process.env.YO_CHAT_DATABASE ?? "data/yo-chat-v2.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
};
const sampling = (publish: (text: string) => void) => createModelSampling(runtime, publish);
export const cardChatHandlers = createCardChatHandlers(runtime, openDatabase, sampling);
export const flightChatHandlers = createDemoHandlers(flightDemo, runtime, openDatabase, sampling);
