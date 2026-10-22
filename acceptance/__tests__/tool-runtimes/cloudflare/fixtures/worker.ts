import { createToolExecutor } from "@sweatpants/tool-runtime-cloudflare/executor";
import { toolsWithExecutionServices, installExecutionServices } from "./execution-setup.ts";
export default createToolExecutor({
  tools: toolsWithExecutionServices,
  setup: installExecutionServices,
});
