import type { AnyToolContract } from "@sweatpants/agent-sdk";
import { installToolRuntime, type ToolRuntime } from "@sweatpants/tool-runtime";
import type { ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import { createInvocationToolRuntimeDriver } from "@sweatpants/tool-session/execution";
import type { Operation } from "effection";
import {
  createAgentCoreToolInvocationRuntime,
  type AgentCoreToolInvocationRuntimeOptions,
} from "./invocation-runtime.ts";
export interface AgentCoreToolRuntimeDriverOptions {
  readonly id?: string;
  readonly tools: AnyToolContract[];
  readonly samplingProvider: ToolSessionSamplingProvider;
  readonly runtime: AgentCoreToolInvocationRuntimeOptions;
}

export function* createAgentCoreToolRuntimeDriver(
  options: AgentCoreToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  yield* createAgentCoreToolInvocationRuntime(options.runtime);
  const runtimeId = options.id ?? "agentcore";
  return yield* createInvocationToolRuntimeDriver({
    id: runtimeId,
    tools: options.tools,
    samplingProvider: options.samplingProvider,
  });
}

export function* installAgentCoreToolRuntime(
  options: AgentCoreToolRuntimeDriverOptions,
): Operation<ToolRuntime> {
  const driver = yield* createAgentCoreToolRuntimeDriver(options);
  yield* installToolRuntime(driver);
  return driver;
}
