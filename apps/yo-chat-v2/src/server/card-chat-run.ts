import type { DatabaseSync } from "node:sqlite";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ChatSampling } from "@sweatpan.ts/chat";
import type { ChatCommand } from "../chat/contract.ts";
export type { ChatRunEvent as CardRunEvent } from "./chat-run.ts";
import { createDemoRun } from "./chat-run.ts";
import { cardDemo } from "./card-chat-program.ts";
export function createCardChatRun<Y>(
  runtime: Runtime<Y>,
  openDatabase: () => DatabaseSync,
  sampling: (publish: (text: string) => void) => Promise<ChatSampling<Y>>,
  thread: string,
  command?: ChatCommand,
) {
  return createDemoRun(cardDemo, runtime, openDatabase, sampling, thread, command);
}
