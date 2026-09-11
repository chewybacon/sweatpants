import type { RuntimeTool } from "@sweatpants/agent-sdk";
import type { Operation } from "effection";
import type { ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import {
  createAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolInvocationRuntime,
  createAwsSdkAgentCoreInvoker,
  type AgentCoreToolRuntimeProfile,
} from "@sweatpants/tool-runtime-agentcore";

import { installYoChatToolRuntime } from "../src/server/tool-runtime-installation.ts";

/** Installs one real AgentCore-hosted tool behind the workflow host ephemeral boundary. */
export function* setupAgentCoreProgramDriverToolRuntime(tool: RuntimeTool): Operation<void> {
  const runtimeArn = requiredEnvironment("AGENTCORE_RUNTIME_ARN");
  const region = requiredEnvironment("AWS_REGION");
  const endpointName = process.env["AGENTCORE_ENDPOINT_NAME"] ?? "DEFAULT";
  const samplingProvider: ToolSessionSamplingProvider = {
    *sample(): Operation<never> {
      throw new Error("AgentCore sampling must be lifted into workflow host");
    },
  };
  const runtimeClient = createAgentCoreRemoteToolRuntimeClient(
    createAwsSdkAgentCoreInvoker({ clientConfig: { region } }),
  );
  const profile: AgentCoreToolRuntimeProfile = {
    name: "program-driver-live-acceptance",
    runtimeArn,
    endpointName,
    region,
    toolNames: [tool.name],
    maxSessionTtlMs: 15 * 60 * 1000,
  };
  const runtimeOptions = {
    runtimeClient,
    profiles: [profile],
    defaultProfile: profile.name,
  };
  yield* createAgentCoreToolInvocationRuntime(runtimeOptions);
  yield* installYoChatToolRuntime({
    mode: "agentcore",
    samplingProvider,
    tools: [tool],
  });
}

/** Whether a live AgentCore acceptance was explicitly requested. */
export function useAgentCoreProgramDriverAcceptance(): boolean {
  return process.env["PROGRAM_DRIVER_ACCEPTANCE_AGENTCORE"] === "1";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for AgentCore acceptance`);
  }
  return value;
}
