import { SchemeEvaluationPort } from "@sweatpants/scheme-runtime";
import { createWorkerSchemeDriver } from "@sweatpants/scheme-runtime/worker";
import { createToolExecutorObject } from "@sweatpants/tool-runtime-cloudflare/executor";
import { programs } from "../../workflow/agent.ts";

export const ToolExecutors = createToolExecutorObject({
  tools: programs,
  *setup() {
    yield* SchemeEvaluationPort.installDriver(createWorkerSchemeDriver());
  },
});
