import { field, object } from "configliere";
import { z } from "zod";

import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeEndpointCommand,
  ListAgentRuntimesCommand,
  type AgentRuntime,
} from "@aws-sdk/client-bedrock-agentcore-control";

const argsParser = object({
  name: field(z.string().min(1), field.default("sweatpants_tool_session_tracer")),
  region: field(z.string().min(1), field.default("us-east-1")),
  endpointName: {
    aliases: ["--endpoint"],
    ...field(z.string().min(1), field.default("DEFAULT")),
  },
  format: field(z.enum(["text", "json", "env"]), field.default("env")),
});

function environmentValues(): Record<string, string> {
  const values: Record<string, string> = {};
  const name = process.env["AGENTCORE_RUNTIME_NAME"];
  const region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"];
  const endpointName = process.env["AGENTCORE_ENDPOINT_NAME"];
  if (name !== undefined) values["name"] = name;
  if (region !== undefined) values["region"] = region;
  if (endpointName !== undefined) values["endpointName"] = endpointName;
  return values;
}

function parseConfiguration() {
  const result = argsParser.parse({
    args: process.argv.slice(2),
    values: [{ name: "environment", value: environmentValues() }],
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  if (result.remainder.args && result.remainder.args.length > 0) {
    throw new Error(`Unexpected arguments: ${result.remainder.args.join(" ")}`);
  }
  return result.value;
}

async function findRuntime(
  client: BedrockAgentCoreControlClient,
  name: string,
): Promise<AgentRuntime | undefined> {
  let nextToken: string | undefined;
  do {
    const response = await client.send(
      new ListAgentRuntimesCommand({ maxResults: 100, nextToken }),
    );
    const found = response.agentRuntimes?.find((runtime) => runtime.agentRuntimeName === name);
    if (found) {
      return found;
    }
    nextToken = response.nextToken;
  } while (nextToken);
  return undefined;
}

async function main(): Promise<void> {
  const { name: runtimeName, region, endpointName, format } = parseConfiguration();

  const client = new BedrockAgentCoreControlClient({ region });
  const runtime = await findRuntime(client, runtimeName);
  if (!runtime?.agentRuntimeArn || !runtime.agentRuntimeId) {
    throw new Error(`AgentCore runtime not found: ${runtimeName}`);
  }

  const endpoint = await client.send(
    new GetAgentRuntimeEndpointCommand({
      agentRuntimeId: runtime.agentRuntimeId,
      endpointName,
    }),
  );

  if (endpoint.status !== "READY") {
    throw new Error(
      `AgentCore runtime endpoint ${endpointName} is not READY (status=${endpoint.status ?? "unknown"})`,
    );
  }

  const payload = {
    runtimeName,
    runtimeArn: runtime.agentRuntimeArn,
    runtimeId: runtime.agentRuntimeId,
    endpointName,
    region,
    endpointStatus: endpoint.status,
  };

  if (format === "json") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (format === "text") {
    console.log(runtime.agentRuntimeArn);
    return;
  }

  console.log(`export AWS_REGION=${JSON.stringify(region)}`);
  console.log(`export AGENTCORE_ENDPOINT_NAME=${JSON.stringify(endpointName)}`);
  console.log(`export AGENTCORE_RUNTIME_ARN=${JSON.stringify(runtime.agentRuntimeArn)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
