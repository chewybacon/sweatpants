import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { durableSelection } from "../../../../fixtures/durable-selection.ts";
await runDurableProgramWorker(createDurableToolRegistry([durableSelection]));
