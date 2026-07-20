import { createDurableToolRegistry } from "@sweatpants/session-contract";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";

import { playTttTool } from "../../src/tools/play-ttt/tool.ts";

await runDurableProgramWorker(createDurableToolRegistry([playTttTool]));
