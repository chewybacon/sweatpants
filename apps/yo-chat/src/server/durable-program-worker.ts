import { isMainThread } from "node:worker_threads";

import { createDurableToolRegistry } from "@sweatpants/session-contract";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";

import { pickCard } from "../tools/pick-card/durable";
import { playTttTool } from "../tools/play-ttt/tool";

if (!isMainThread) {
  await runDurableProgramWorker(createDurableToolRegistry([pickCard, playTttTool]));
}
