import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
  type GetAgentRuntimeEndpointCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore-control";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function waitEndpoint(
  client: BedrockAgentCoreControlClient,
  runtimeId: string,
): Promise<GetAgentRuntimeEndpointCommandOutput> {
  const deadline = Date.now() + Number(process.env["AGENTCORE_ENDPOINT_WAIT_MS"] ?? "600000");
  let last: GetAgentRuntimeEndpointCommandOutput | undefined;
  while (Date.now() < deadline) {
    try {
      last = await client.send(
        new GetAgentRuntimeEndpointCommand({
          agentRuntimeId: runtimeId,
          endpointName: "DEFAULT",
        }),
      );
      console.log(`endpoint_status=${last.status}`);
      if (last.status === "READY") return last;
      if (last.status === "CREATE_FAILED" || last.status === "UPDATE_FAILED") {
        throw new Error("AgentCore endpoint creation failed");
      }
    } catch (error) {
      if ((error as { name?: string }).name !== "ResourceNotFoundException") throw error;
      console.log("endpoint_status=not-found");
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(
    `Timed out waiting for AgentCore endpoint; last status=${last?.status ?? "none"}`,
  );
}

async function main(): Promise<void> {
  if (process.env["APPROVE_AGENTCORE_MUTATION"] !== "yes") {
    throw new Error("Set APPROVE_AGENTCORE_MUTATION=yes after explicit deployment approval");
  }
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const runtimeName = required("AGENTCORE_RUNTIME_NAME");
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(runtimeName)) {
    throw new Error("AGENTCORE_RUNTIME_NAME is invalid");
  }
  const releaseId = required("AGENTCORE_DURABLE_RELEASE_ID");
  const registryDigest = required("AGENTCORE_DURABLE_REGISTRY_DIGEST");
  const imageUri = required("IMAGE_URI");
  const roleArn = required("AGENTCORE_EXECUTION_ROLE_ARN");
  if (!imageUri.includes("@sha256:")) {
    throw new Error("IMAGE_URI must pin an ECR image digest");
  }
  const idle = Number(process.env["AGENTCORE_IDLE_TIMEOUT"] ?? "120");
  const maximum = Number(process.env["AGENTCORE_MAX_LIFETIME"] ?? "28800");
  if (!Number.isInteger(idle) || idle < 120 || idle > 300 || maximum < idle || maximum > 28_800) {
    throw new Error("AgentCore lifecycle configuration is outside durable release bounds");
  }
  const client = new BedrockAgentCoreControlClient({ region });
  const created = await client.send(
    new CreateAgentRuntimeCommand({
      agentRuntimeName: runtimeName,
      clientToken: randomUUID(),
      agentRuntimeArtifact: { containerConfiguration: { containerUri: imageUri } },
      roleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: { serverProtocol: "HTTP" },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: idle,
        maxLifetime: maximum,
      },
      filesystemConfigurations: [{ sessionStorage: { mountPath: "/mnt/workspace" } }],
      environmentVariables: {
        AGENTCORE_DURABLE_RELEASE_ID: releaseId,
        AGENTCORE_DURABLE_REGISTRY_DIGEST: registryDigest,
        AGENTCORE_WORKSPACE_PATH: "/mnt/workspace",
      },
      description: `Sweatpants immutable durable evaluator ${releaseId}`,
      tags: {
        project: "sweatpants-agentcore-durable-program-runtime",
        release: releaseId,
      },
    }),
  );
  if (!created.agentRuntimeId || !created.agentRuntimeArn) {
    throw new Error("CreateAgentRuntime did not return runtime identity");
  }
  const endpoint = await waitEndpoint(client, created.agentRuntimeId);
  const output = {
    releaseId,
    registryDigest,
    agentRuntimeName: runtimeName,
    agentRuntimeId: created.agentRuntimeId,
    agentRuntimeArn: created.agentRuntimeArn,
    imageUri,
    region,
    filesystem: { mountPath: "/mnt/workspace" },
    lifecycle: { idleRuntimeSessionTimeoutSeconds: idle, maxLifetimeSeconds: maximum },
    endpoint,
  };
  await writeFile(
    "agentcore-durable-program-runtime-deploy-output.json",
    JSON.stringify(output, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify({
      releaseId,
      agentRuntimeName: runtimeName,
      endpointStatus: endpoint.status,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
