import type { DatabaseSync } from "node:sqlite";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createStandaloneHandlers } from "../standalone/server.ts";
import { cardApplicationOptions } from "./pick-card.ts";
import { pickCard } from "../tools/pick-card.ts";

/** The example owns HTTP, projection and advancement policy. */
export function createCardHandlers<Y>(runtime: Runtime<Y>, openDatabase: () => DatabaseSync) {
  return createStandaloneHandlers(runtime, pickCard, cardApplicationOptions(runtime, openDatabase));
}
