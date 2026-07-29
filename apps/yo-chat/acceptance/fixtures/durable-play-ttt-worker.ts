import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";

import { playTttTool } from "../../src/tools/play-ttt/tool.ts";

await runDurableProgramWorker(createDurableToolRegistry([playTttTool]));
