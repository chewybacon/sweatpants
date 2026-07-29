import type { RuntimeTool } from "@sweatpants/agent-sdk";
import type { Operation } from "effection";
import { createPluginSessionManager } from "@sweatpants/durable-chat-runtime/durable-handler";
import type { ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import {
  createAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolSessionRegistry,
  createAwsSdkAgentCoreInvoker,
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
  type AgentCoreToolRuntimeProfile,
} from "@sweatpants/tool-runtime-agentcore";

import { installYoChatToolRuntime } from "../src/server/tool-runtime-installation.ts";

/** Installs one real AgentCore-hosted tool behind the ProgramRuntime foreign boundary. */
export function* setupAgentCoreProgramDriverToolRuntime(tool: RuntimeTool): Operation<void> {
  const runtimeArn = requiredEnvironment("AGENTCORE_RUNTIME_ARN");
  const region = requiredEnvironment("AWS_REGION");
  const endpointName = process.env["AGENTCORE_ENDPOINT_NAME"] ?? "DEFAULT";
  const samplingProvider: ToolSessionSamplingProvider = {
    *sample(): Operation<never> {
      throw new Error("AgentCore sampling must be lifted into ProgramRuntime");
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
  const pluginRegistry = createAgentCoreToolSessionRegistry({
    stores: {
      handles: createInMemoryAgentCoreToolSessionHandleStore(),
      events: createInMemoryAgentCoreToolSessionEventStore(),
    },
    runtimeClient,
    profiles: [profile],
    defaultProfile: profile.name,
  });
  const pluginManager = yield* createPluginSessionManager({
    registry: pluginRegistry,
    samplingProvider,
  });
  yield* installYoChatToolRuntime({
    mode: "agentcore",
    registry: pluginRegistry,
    pluginManager,
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
