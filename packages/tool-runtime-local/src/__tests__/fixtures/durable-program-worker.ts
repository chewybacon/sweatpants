import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { DURABLE_DRIVER_FIXTURE_TOOLS } from "@sweatpants/session-contract/testing";

import { runDurableProgramWorker } from "../../durable-worker-runner.ts";

await runDurableProgramWorker(createDurableToolRegistry(DURABLE_DRIVER_FIXTURE_TOOLS));
