import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeEndpointCommand,
  ListAgentRuntimesCommand,
  type AgentRuntime,
} from "@aws-sdk/client-bedrock-agentcore-control";

function parseArgs(argv: string[]) {
  const result: {
    name?: string;
    region?: string;
    endpointName?: string;
    format?: "text" | "json" | "env";
  } = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--name") {
      const value = argv[++i];
      if (value !== undefined) {
        result.name = value;
      }
    } else if (arg === "--region") {
      const value = argv[++i];
      if (value !== undefined) {
        result.region = value;
      }
    } else if (arg === "--endpoint") {
      const value = argv[++i];
      if (value !== undefined) {
        result.endpointName = value;
      }
    } else if (arg === "--format") {
      const value = argv[++i];
      if (value === "text" || value === "json" || value === "env") {
        result.format = value;
      }
    }
  }

  return result;
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
  const args = parseArgs(process.argv.slice(2));
  const runtimeName =
    args.name ?? process.env["AGENTCORE_RUNTIME_NAME"] ?? "sweatpants_tool_session_tracer";
  const region =
    args.region ?? process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";
  const endpointName = args.endpointName ?? process.env["AGENTCORE_ENDPOINT_NAME"] ?? "DEFAULT";
  const format = args.format ?? "env";

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
