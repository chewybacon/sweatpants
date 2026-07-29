import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";

import { pickCard } from "../../src/tools/pick-card/durable";

await runDurableProgramWorker(createDurableToolRegistry([pickCard]));
