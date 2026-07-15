import { isMainThread } from "node:worker_threads";

import { createDurableToolRegistry } from "@sweatpants/session-contract";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";

import { pickCard } from "../tools/pick-card/durable";

if (!isMainThread) {
  await runDurableProgramWorker(createDurableToolRegistry([pickCard]));
}
