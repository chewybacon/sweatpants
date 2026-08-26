import type { AgentCoreRuntimeRelease } from "@sweatpants/tool-runtime-agentcore";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { run } from "effection";

import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import {
  createAuthorityScenarioDriver,
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
} from "@sweatpants/journal-authority/testing";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import { type AdvancementResult, type ProgramRoute } from "@sweatpants/durable-execution";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import {
  createProgramDriverRegistry,
  ProgramDriverRegistryContext,
} from "@sweatpants/durable-execution";
import {
  createAgentCoreDurableProgramDriver,
  createAgentCoreWebSocketProgramTransport,
  createInvocationAgentCorePlacement,
  createSigV4AgentCoreWebSocketConnector,
} from "@sweatpants/tool-runtime-agentcore";
import { drawPickCards, pickCard } from "../../yo-chat/src/tools/pick-card/durable.ts";

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
const taskId = `workflow-host-${randomUUID()}`;
const sessionId = `workflow-host-session-${randomUUID()}`;
const program = {
  id: pickCard.manifest.programId,
  version: pickCard.manifest.version,
  digest: pickCard.manifest.digest,
};
const placement = createInvocationAgentCorePlacement({
  journalId: "live-workflow-host",
  rootTaskId: taskId,
  program,
  release,
});
const route = { driverKind: "agentcore", placement } as unknown as ProgramRoute;
const connector = createSigV4AgentCoreWebSocketConnector();
const driver = createAgentCoreDurableProgramDriver(
  createAgentCoreWebSocketProgramTransport(connector),
);
const authority = createAuthorityScenarioDriver({
  journalId: "live-workflow-host",
  journalIncarnation: "1",
  keyring: createCapabilityKeyring("live-workflow-host", [
    { keyId: "live", secret: randomUUID().repeat(2) },
  ]),
  schemaRegistry: createDurableSchemaRegistry(pickCard.artifacts.catalog),
});
const effects = createDurableEffectRegistry([
  createDurableEffectRegistration(
    drawPickCards,
    { mode: "idempotent", mechanism: "pull_id_key" },
    function* () {
      return {
        status: "ok" as const,
        value: {
          cards: [
            { rank: "A", suit: "spades", display: "A♠" },
            { rank: "K", suit: "hearts", display: "K♥" },
            { rank: "Q", suit: "clubs", display: "Q♣" },
          ],
        },
      };
    },
  ),
]);
const drivers = createProgramDriverRegistry([["agentcore", driver]]);
await run(() =>
  authority.openTask({
    sessionId,
    turnId: "turn-0",
    taskId,
    manifest: pickCard.manifest,
    input: { count: 3 },
    executionEpoch: 1,
    attachmentId: "unattached",
    audience: "workflow-host",
  }),
);

async function activate(ownerId: string): Promise<AdvancementResult> {
  return await run(function* () {
    const claim = yield* authority.claimActivation({ sessionId, ownerId });
    if (claim.status !== "claimed") {
      throw new Error(`activation claim failed: ${claim.status}`);
    }
    let reason: "parked" | "terminal" | "failed" = "failed";
    try {
      const outcome = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* withProgramDriverTestScope(authority, function* () {
          return yield* DurableEffectRegistryContext.with(effects, function* () {
            return yield* driveInstalledTestProgramTree({
              attach: {
                sessionId,
                taskId,
                program,
                input: { count: 3 },
                route,
                executionEpoch: claim.epoch,
              },
              activationOwnerId: ownerId,
            });
          });
        });
      });
      reason = outcome.state === "parked" ? "parked" : "terminal";
      return outcome;
    } finally {
      yield* authority.releaseActivation({ sessionId, ownerId, epoch: claim.epoch, reason });
    }
  });
}

const firstStarted = Date.now();
const first = await activate("live-owner-1");
if (first.state !== "parked") {
  throw new Error(`first activation did not park: ${first.state}`);
}
const journal = authority.readJournal(sessionId);
const elicit = [...journal]
  .reverse()
  .find(
    (record) =>
      record.payload.type === "PullRequested" && record.payload.descriptor.kind === "elicit",
  );
if (
  !elicit ||
  elicit.payload.type !== "PullRequested" ||
  elicit.payload.descriptor.kind !== "elicit"
) {
  throw new Error("parked pick_card elicit was not journaled");
}
const context = elicit.payload.descriptor.context as {
  cards: Array<{ rank: string; suit: string; display: string }>;
};
const selected = context.cards[0];
if (!selected) {
  throw new Error("pick_card context contained no cards");
}
const capability = authority.resolutionCapability(sessionId, taskId, elicit.payload.pullId);
const resolution = await run(() =>
  authority.resolve({
    capability,
    audience: "user:pickCard",
    outcome: { status: "ok", value: { action: "accept", content: { picked: selected } } },
  }),
);
if (resolution.status === "rejected") {
  throw new Error(`elicit resolution failed: ${resolution.code}`);
}
const resumeStarted = Date.now();
const second = await activate("live-owner-2");
if (second.state !== "completed") {
  throw new Error(`second activation did not complete: ${second.state}`);
}
const streamedResumeMs = Date.now() - resumeStarted;
await run(function* () {
  if (connector.stopRuntimeSession) {
    const controller = new AbortController();
    yield* connector.stopRuntimeSession({
      release,
      runtimeSessionId: placement.runtimeSessionId,
      signal: controller.signal,
    });
  }
});
console.log(
  JSON.stringify({
    releaseId: release.releaseId,
    firstActivationMs: resumeStarted - firstStarted,
    streamedResumeMs,
    journalRecordTypes: authority.readJournal(sessionId).map((record) => record.payload.type),
    completed: true,
  }),
);
