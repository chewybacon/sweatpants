import { isMainThread } from "node:worker_threads";

import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";

import { tools } from "./tool-definitions";

if (!isMainThread) {
  await runDurableProgramWorker(
    createDurableToolRegistry(tools.filter((tool) => tool.execution === "crank_native")),
  );
}
