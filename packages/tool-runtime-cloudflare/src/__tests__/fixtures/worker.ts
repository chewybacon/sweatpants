import { createToolExecutor } from "../../executor.ts";
import { DURABLE_DRIVER_FIXTURE_TOOLS } from "@sweatpants/journal-authority/testing";
export default createToolExecutor({ tools: DURABLE_DRIVER_FIXTURE_TOOLS });
