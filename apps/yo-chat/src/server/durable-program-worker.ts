import { isMainThread } from "node:worker_threads";

import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";

import { pickCard } from "../tools/pick-card/durable";
import { playTttTool } from "../tools/play-ttt/tool";

if (!isMainThread) {
  await runDurableProgramWorker(createDurableToolRegistry([pickCard, playTttTool]));
}
