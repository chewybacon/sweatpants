import type { DatabaseSync } from "node:sqlite";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ChatSampling } from "@sweatpan.ts/chat";
import { createDemoHandlers } from "./chat-handlers.ts";
import { cardDemo } from "./card-chat-program.ts";
export function createCardChatHandlers<Y>(
  runtime: Runtime<Y>,
  openDatabase: () => DatabaseSync,
  sampling: (publish: (text: string) => void) => Promise<ChatSampling<Y>>,
) {
  return createDemoHandlers(cardDemo, runtime, openDatabase, sampling);
}
