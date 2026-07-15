import { createDurableToolRegistry } from "@sweatpants/session-contract";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";

import { runtimeDurablePickCard } from "../../src/tools/pick-card/durable";

await runDurableProgramWorker(createDurableToolRegistry([runtimeDurablePickCard]));
