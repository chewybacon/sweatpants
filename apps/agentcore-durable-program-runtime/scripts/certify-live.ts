import type { AgentCoreRuntimeRelease } from "@sweatpants/tool-runtime-agentcore";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { run } from "effection";

import { type ProgramRoute, type ReplayOperationEntry } from "@sweatpants/durable-execution";
import { canonicalDigest } from "@sweatpants/foundation";
import {
  computeReplayChainSeed,
  createAgentCoreDurableProgramDriver,
  createAgentCoreWebSocketProgramTransport,
  createInvocationAgentCorePlacement,
  createSigV4AgentCoreWebSocketConnector,
  linkReplayEntry,
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
interface Diagnostics {
  computeGeneration: string;
  pid?: number;
  acknowledged?: boolean;
  present?: boolean;
  markerDigest?: string;
}

if (process.env["APPROVE_AGENTCORE_PAID_TESTS"] !== "yes") {
  throw new Error("APPROVE_AGENTCORE_PAID_TESTS=yes is required");
}
const deployment = JSON.parse(
  await readFile("agentcore-durable-program-runtime-deploy-output.json", "utf8"),
) as DeploymentOutput;
const imageDigest = deployment.imageUri.split("@")[1];
if (!imageDigest) {
  throw new Error("Deployment image is not digest-pinned");
}
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
const transport = createAgentCoreWebSocketProgramTransport(
  createSigV4AgentCoreWebSocketConnector(),
);
const driver = createAgentCoreDurableProgramDriver(transport);
const client = new BedrockAgentCoreClient({ region: release.region });
const sessions = new Set<string>();

async function bodyToString(body: unknown): Promise<string> {
  if (!body || typeof body !== "object") {
    return "";
  }
  if ("transformToString" in body && typeof body.transformToString === "function") {
    return await body.transformToString();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function diagnostic(
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<Diagnostics> {
  sessions.add(sessionId);
  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: release.runtimeArn,
      qualifier: "DEFAULT",
      runtimeSessionId: sessionId,
      payload: Buffer.from(JSON.stringify(payload)),
      contentType: "application/json",
      accept: "application/json",
    }),
  );
  const text = await bodyToString(response.response);
  return JSON.parse(text) as Diagnostics;
}

async function stop(sessionId: string): Promise<void> {
  await client
    .send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: release.runtimeArn,
        qualifier: "DEFAULT",
        runtimeSessionId: sessionId,
        clientToken: randomUUID(),
      }),
    )
    .catch(() => undefined);
}

async function replayPickCard(): Promise<{
  warmGeneration: string;
  coldGeneration: string;
  coldResumeMs: number;
}> {
  const taskId = `pick-card-${randomUUID()}`;
  const placement = createInvocationAgentCorePlacement({
    journalId: "live-certification",
    rootTaskId: taskId,
    program,
    release,
  });
  sessions.add(placement.runtimeSessionId);
  const route = { driverKind: "agentcore", placement } as unknown as ProgramRoute;
  const attach = {
    sessionId: "live-certification",
    taskId,
    program,
    input: { count: 3 },
    route,
    executionEpoch: 1,
  };
  const first = await run(function* () {
    const attachment = yield* driver.attach(attach);
    try {
      const effectStep = yield* driver.step(attachment, { type: "start", input: attach.input });
      if (effectStep.type !== "operation" || effectStep.descriptor.kind !== "effect") {
        throw new Error("pick_card did not yield its host effect");
      }
      const outcome = {
        status: "ok" as const,
        value: {
          cards: [
            { rank: "A", suit: "spades", display: "A♠" },
            { rank: "K", suit: "hearts", display: "K♥" },
            { rank: "Q", suit: "clubs", display: "Q♣" },
          ],
        },
      };
      const receipt = {
        sessionId: attach.sessionId,
        taskId,
        pullId: "live-effect-pull",
        resolutionOffset: "2",
        outcomeDigest: canonicalDigest(outcome),
        status: "accepted" as const,
      };
      const frontier = yield* driver.step(attachment, {
        type: "resume",
        actionIndex: effectStep.actionIndex,
        outcome,
        receipt,
        replayed: false,
      });
      if (frontier.type !== "operation" || frontier.descriptor.kind !== "elicit") {
        throw new Error("pick_card did not reach its elicit frontier");
      }
      return { effectStep, outcome, receipt };
    } finally {
      yield* driver.shutdown(attachment, "parked");
    }
  });
  const replayChainSeed = computeReplayChainSeed({
    releaseId: release.releaseId,
    sessionId: attach.sessionId,
    taskId,
    program,
    activationEpoch: 2,
    journalHeadId: "a".repeat(64),
    restoreNonce: randomUUID(),
  });
  const replayEntry = linkReplayEntry(replayChainSeed, replayChainSeed, {
    type: "operation",
    actionIndex: first.effectStep.actionIndex,
    descriptorKind: first.effectStep.descriptor.kind,
    descriptorDigest: canonicalDigest(first.effectStep.descriptor),
    outcome: first.outcome,
    receipt: first.receipt,
  }) as ReplayOperationEntry;
  const warm = await run(function* () {
    // This certification checks the remote protocol's compute generation, which
    // is transport evidence rather than a guarantee of shared driver replay.
    const restored = yield* transport.restore!({
      checkpoint: { kind: "replay" },
      attach: { ...attach, executionEpoch: 2 },
      replay: [replayEntry],
      replayedThroughActionIndex: 0,
      replayChainSeed,
      replayChainDigest: replayEntry.entryDigest,
    });
    try {
      if (
        restored.frontier.type !== "operation" ||
        restored.frontier.descriptor.kind !== "elicit"
      ) {
        throw new Error("warm replay did not restore the elicit frontier");
      }
      if (!restored.computeGeneration) {
        throw new Error("warm restore omitted compute generation");
      }
      return restored.computeGeneration;
    } finally {
      yield* driver.shutdown(restored.attachment, "parked");
    }
  });
  await stop(placement.runtimeSessionId);
  const coldStarted = Date.now();
  const coldSeed = computeReplayChainSeed({
    releaseId: release.releaseId,
    sessionId: attach.sessionId,
    taskId,
    program,
    activationEpoch: 3,
    journalHeadId: "a".repeat(64),
    restoreNonce: randomUUID(),
  });
  const coldEntry = linkReplayEntry(coldSeed, coldSeed, {
    type: "operation",
    actionIndex: first.effectStep.actionIndex,
    descriptorKind: first.effectStep.descriptor.kind,
    descriptorDigest: canonicalDigest(first.effectStep.descriptor),
    outcome: first.outcome,
    receipt: first.receipt,
  }) as ReplayOperationEntry;
  const cold = await run(function* () {
    // This certification checks the remote protocol's compute generation, which
    // is transport evidence rather than a guarantee of shared driver replay.
    const restored = yield* transport.restore!({
      checkpoint: { kind: "replay" },
      attach: { ...attach, executionEpoch: 3 },
      replay: [coldEntry],
      replayedThroughActionIndex: 0,
      replayChainSeed: coldSeed,
      replayChainDigest: coldEntry.entryDigest,
    });
    try {
      if (
        restored.frontier.type !== "operation" ||
        restored.frontier.descriptor.kind !== "elicit"
      ) {
        throw new Error("cold replay did not restore the elicit frontier");
      }
      if (!restored.computeGeneration) {
        throw new Error("cold restore omitted compute generation");
      }
      return restored.computeGeneration;
    } finally {
      yield* driver.shutdown(restored.attachment, "parked");
    }
  });
  if (warm === cold) {
    throw new Error("explicit stop did not change compute generation");
  }
  return { warmGeneration: warm, coldGeneration: cold, coldResumeMs: Date.now() - coldStarted };
}

const evidence: Record<string, unknown> = {
  releaseId: release.releaseId,
  imageDigest: release.imageDigest,
  registryDigest: release.registryDigest,
  startedAt: new Date().toISOString(),
};
try {
  const explicitSession = `storage-explicit-${randomUUID()}`;
  const explicitMarker = `explicit-${randomUUID()}`;
  const written = await diagnostic(explicitSession, {
    op: "storage_write",
    marker: explicitMarker,
  });
  await stop(explicitSession);
  const explicitRead = await diagnostic(explicitSession, {
    op: "storage_read",
    marker: explicitMarker,
  });
  evidence["explicitStop"] = {
    markerPreserved:
      explicitRead.present === true && explicitRead.markerDigest === written.markerDigest,
    generationChanged: explicitRead.computeGeneration !== written.computeGeneration,
  };

  const isolatedSession = `storage-isolated-${randomUUID()}`;
  const isolatedRead = await diagnostic(isolatedSession, {
    op: "storage_read",
    marker: explicitMarker,
  });
  evidence["crossSessionIsolation"] = isolatedRead.present === false;

  const replay = await replayPickCard();
  evidence["pickCardReplay"] = {
    explicitStopChangedGeneration: replay.warmGeneration !== replay.coldGeneration,
    coldResumeMs: replay.coldResumeMs,
  };

  if (process.env["AGENTCORE_CERTIFY_SKIP_IDLE"] !== "yes") {
    const idleSession = `storage-idle-${randomUUID()}`;
    const idleMarker = `idle-${randomUUID()}`;
    const idleWritten = await diagnostic(idleSession, { op: "storage_write", marker: idleMarker });
    const idleWaitMs = (release.lifecycle.idleRuntimeSessionTimeoutSeconds + 20) * 1_000;
    await new Promise((resolve) => setTimeout(resolve, idleWaitMs));
    const idleRead = await diagnostic(idleSession, { op: "storage_read", marker: idleMarker });
    evidence["idleStop"] = {
      waitedMs: idleWaitMs,
      markerPreserved:
        idleRead.present === true && idleRead.markerDigest === idleWritten.markerDigest,
      generationChanged: idleRead.computeGeneration !== idleWritten.computeGeneration,
    };
  }
  evidence["completedAt"] = new Date().toISOString();
  await mkdir("live-evidence", { recursive: true });
  const evidencePath = `live-evidence/${release.releaseId}.json`;
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify({ evidencePath, ...evidence }));
} finally {
  await Promise.all([...sessions].map(stop));
  client.destroy();
}
