import { readFile } from "node:fs/promises";

import { run } from "effection";

import type { AgentCoreRuntimeRelease, ProgramRoute } from "@sweatpants/session-contract";
import {
  createAgentCoreDurableProgramDriver,
  createAgentCoreWebSocketProgramTransport,
  createInvocationAgentCorePlacement,
  createSigV4AgentCoreWebSocketConnector,
} from "@sweatpants/tool-runtime-agentcore";

interface DeploymentOutput {
  releaseId: string;
  registryDigest: string;
  agentRuntimeArn: string;
  imageUri: string;
  region: string;
  lifecycle: {
    idleRuntimeSessionTimeoutSeconds: number;
    maxLifetimeSeconds: number;
  };
}

const deployment = JSON.parse(
  await readFile("agentcore-durable-program-runtime-deploy-output.json", "utf8"),
) as DeploymentOutput;
const imageDigest = deployment.imageUri.split("@")[1];
if (!imageDigest) throw new Error("Deployment image URI is not digest-pinned");
const release: AgentCoreRuntimeRelease = {
  releaseId: deployment.releaseId,
  runtimeArn: deployment.agentRuntimeArn,
  region: deployment.region,
  imageDigest,
  protocolVersion: 1,
  registryDigest: deployment.registryDigest,
  iamProfile: "sweatpants-agentcore-durable-runtime-exec",
  networkProfile: "PUBLIC",
  filesystem: { kind: "managed_session_storage", mountPath: "/mnt/workspace" },
  lifecycle: deployment.lifecycle,
};
const program = {
  id: "pick_card",
  version: "2.0.0",
  digest: "665d712a75e3914820798aba6979fbab13bcdc556e8936b589ba57b8c6066889",
};
const taskId = `live-smoke-${Date.now()}`;
const placement = createInvocationAgentCorePlacement({
  journalId: "live-smoke",
  rootTaskId: taskId,
  program,
  release,
});
const driver = createAgentCoreDurableProgramDriver(
  createAgentCoreWebSocketProgramTransport(createSigV4AgentCoreWebSocketConnector()),
);
const started = Date.now();
const evidence = await run(function* () {
  const attachment = yield* driver.attach({
    sessionId: "live-smoke",
    taskId,
    program,
    input: { count: 3 },
    route: { driverKind: "agentcore", placement } as unknown as ProgramRoute,
    executionEpoch: 1,
  });
  try {
    const step = yield* driver.step(attachment, { type: "start", input: { count: 3 } });
    return {
      attachmentDriverKind: attachment.driverKind,
      stepType: step.type,
      actionIndex: step.actionIndex,
      descriptorKind: step.type === "operation" ? step.descriptor.kind : undefined,
    };
  } finally {
    yield* driver.shutdown(attachment, "parked");
  }
});
console.log(
  JSON.stringify({
    releaseId: release.releaseId,
    durationMs: Date.now() - started,
    ...evidence,
  }),
);
