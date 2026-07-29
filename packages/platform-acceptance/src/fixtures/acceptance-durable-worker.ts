import { isMainThread } from "node:worker_threads";
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";
import { acceptanceDurableTool } from "./acceptance-durable.tool.ts";

if (!isMainThread) {
  await runDurableProgramWorker(createDurableToolRegistry([acceptanceDurableTool]));
}
