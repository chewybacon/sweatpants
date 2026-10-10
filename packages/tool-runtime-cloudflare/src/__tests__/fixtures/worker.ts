import { createToolExecutor } from "../../executor.ts";
import { toolsWithExecutionServices, installExecutionServices } from "./execution-setup.ts";
export default createToolExecutor({
  tools: toolsWithExecutionServices,
  setup: installExecutionServices,
});
