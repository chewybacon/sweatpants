import {
  decodeModelSampleRequest,
  decodeModelSampleSourceRequest,
  encodeModelSampleResult,
  encodeModelSampleSourceRequest,
  resolveModelSampleSourceRequest,
} from "@sweatpants/model-sampling";
import type { AgentCoreRuntimeRelease } from "@sweatpants/tool-runtime-agentcore";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { run } from "effection";

import config from "../../yo-chat/sweatpants.config.ts";
import { playTttTool } from "../../yo-chat/src/tools/play-ttt/tool.ts";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import {
  createAuthorityScenarioDriver,
  driveInstalledTestProgramTree,
  withProgramDriverTestPullResolvers,
  withProgramDriverTestSampleStager,
  withProgramDriverTestScope,
} from "@sweatpants/journal-authority/testing";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import { type AdvancementResult } from "@sweatpants/durable-execution";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import { assertJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";
import type { PullResolver } from "@sweatpants/journal-authority";
import {
  createProgramDriverRegistry,
  ProgramDriverRegistryContext,
  type ProgramRoute,
} from "@sweatpants/durable-execution";
import {
  createAgentCoreDurableProgramDriver,
  createAgentCoreWebSocketProgramTransport,
  createInvocationAgentCorePlacement,
  createSigV4AgentCoreWebSocketConnector,
} from "@sweatpants/tool-runtime-agentcore";
import {
  bundleConfiguredPrograms,
  reconstructCollectionProgram,
  type PublishedCollectionRefV1,
} from "@sweatpants/cli/remote-development";

interface DeploymentOutput {
  readonly releaseId: string;
  readonly registryDigest: string;
  readonly agentRuntimeArn: string;
  readonly imageUri: string;
  readonly region: string;
  readonly lifecycle: {
    readonly idleRuntimeSessionTimeoutSeconds: number;
    readonly maxLifetimeSeconds: number;
  };
}

async function main(): Promise<void> {
  if (process.env["APPROVE_AGENTCORE_PAID_TESTS"] !== "yes") {
    throw new Error("APPROVE_AGENTCORE_PAID_TESTS=yes is required");
  }
  const deployment = JSON.parse(
    await readFile("agentcore-remote-development-deploy-output.json", "utf8"),
  ) as DeploymentOutput;
  const collection = JSON.parse(required("PUBLISHED_COLLECTION_JSON")) as PublishedCollectionRefV1;
  const imageDigest = deployment.imageUri.split("@")[1];
  if (!imageDigest) {
    throw new Error("Deployment image is not digest-pinned");
  }

  const built = await bundleConfiguredPrograms({
    projectRoot: resolve(process.cwd(), "../yo-chat"),
    programs: config.programs,
    builderVersion: "0.1.0",
    evaluatorAbi: "agentcore-development-v1",
    platform: "linux-arm64",
    allowedEvaluatorImports: ["node:process"],
  });
  if (built.manifest.collectionDigest !== collection.collectionDigest) {
    throw new Error("Local exact collection differs from the remotely ready collection");
  }
  const entry = built.manifest.programs["play_ttt"]!;
  const entryBytes = built.files.get(entry.entrypoint)!;
  const releaseProgram = reconstructCollectionProgram(playTttTool, entry, entryBytes);
  const program = {
    id: releaseProgram.manifest.programId,
    version: releaseProgram.manifest.version,
    digest: releaseProgram.manifest.digest,
  };
  const release: AgentCoreRuntimeRelease = {
    releaseId: deployment.releaseId,
    runtimeArn: deployment.agentRuntimeArn,
    region: deployment.region,
    imageDigest,
    protocolVersion: 1,
    registryDigest: deployment.registryDigest,
    iamProfile: "sweatpants-remote-dev-f9fdea17-exec",
    networkProfile: "PUBLIC",
    filesystem: { kind: "managed_session_storage", mountPath: "/mnt/workspace" },
    lifecycle: deployment.lifecycle,
  };
  const taskId = `development-play-ttt-${randomUUID()}`;
  const sessionId = `development-play-ttt-session-${randomUUID()}`;
  const basePlacement = createInvocationAgentCorePlacement({
    journalId: "live-development-play-ttt",
    rootTaskId: taskId,
    program,
    release,
  });
  const placement = {
    ...basePlacement,
    development: {
      collection,
      publicKey: "play_ttt",
      evaluatorAbi: "agentcore-development-v1",
    },
  };
  const route: ProgramRoute = assertJson({ driverKind: "agentcore", placement });
  const connector = createSigV4AgentCoreWebSocketConnector();
  const driver = createAgentCoreDurableProgramDriver(
    createAgentCoreWebSocketProgramTransport(connector),
  );
  let modelSamples = 0;
  const effects = createDurableEffectRegistry([]);
  const contexts = new Map<
    string,
    ReturnType<typeof decodeModelSampleRequest>["invocation"]["context"]
  >();
  const stageSampleInput = function* (input: Json) {
    const request = decodeModelSampleRequest(input);
    const snapshot = canonicalSnapshot(request.invocation.context);
    const objectId = `certification-context:${snapshot.sha}`;
    contexts.set(objectId, request.invocation.context);
    return encodeModelSampleSourceRequest({
      ...request,
      invocation: {
        context: { type: "object", object: { objectId }, digest: snapshot.sha },
        ...(request.invocation.options === undefined
          ? {}
          : { options: request.invocation.options }),
      },
    });
  };
  const sampleResolver: PullResolver = {
    kind: "sample",
    audience: () => "model-runtime",
    *perform(_context, descriptor) {
      if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        throw new Error("model sample descriptor is malformed");
      }
      const source = decodeModelSampleSourceRequest(descriptor["input"]);
      if (source.invocation.context.type !== "object") {
        throw new Error("certification requires an object model context source");
      }
      const context = contexts.get(source.invocation.context.object.objectId);
      if (!context || canonicalSnapshot(context).sha !== source.invocation.context.digest) {
        throw new Error("certification model context source is unavailable");
      }
      const request = resolveModelSampleSourceRequest(source, context);
      modelSamples += 1;
      return {
        status: "ok",
        value: encodeModelSampleResult({
          message: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "first legal cell" }],
            },
            source: null,
            usage: null,
            stopReason: null,
            responseId: null,
            errorMessage: null,
          },
          output: {
            type: "json",
            value: { cell: firstEmptyPosition(request.invocation.context.messages) },
          },
        }),
      };
    },
  };
  const authority = createAuthorityScenarioDriver({
    journalId: "live-development-play-ttt",
    journalIncarnation: "1",
    keyring: createCapabilityKeyring("live-development-play-ttt", [
      { keyId: "live", secret: randomUUID().repeat(2) },
    ]),
    schemaRegistry: createDurableSchemaRegistry(playTttTool.artifacts.catalog),
  });
  const drivers = createProgramDriverRegistry([["agentcore", driver]]);
  await run(() =>
    authority.openTask({
      sessionId,
      turnId: "turn-0",
      taskId,
      manifest: releaseProgram.manifest,
      input: {},
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
            return yield* withProgramDriverTestSampleStager(stageSampleInput, function* () {
              return yield* withProgramDriverTestPullResolvers([sampleResolver], function* () {
                return yield* DurableEffectRegistryContext.with(effects, function* () {
                  return yield* driveInstalledTestProgramTree({
                    attach: {
                      sessionId,
                      taskId,
                      program,
                      input: {},
                      route,
                      executionEpoch: claim.epoch,
                    },
                    activationOwnerId: ownerId,
                  });
                });
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

  const started = Date.now();
  let outcome = await activate("live-owner-0");
  let responses = 0;
  for (let round = 0; outcome.state === "parked" && round < 12; round += 1) {
    const pending = [...authority.readJournal(sessionId)]
      .reverse()
      .find(
        (record) =>
          record.payload.type === "PullRequested" && record.payload.descriptor.kind === "elicit",
      );
    if (
      !pending ||
      pending.payload.type !== "PullRequested" ||
      pending.payload.descriptor.kind !== "elicit"
    ) {
      throw new Error("parked play_ttt elicitation was not journaled");
    }
    const context = pending.payload.descriptor.context as Json;
    const pullId = pending.payload.pullId;
    const position = containsGameOver(context) ? -1 : firstEmptyBoardPosition(context);
    const resolution = await run(() =>
      authority.resolve({
        capability: authority.resolutionCapability(sessionId, taskId, pullId),
        audience: "user:pickMove",
        outcome: { status: "ok", value: { action: "accept", content: { position } } },
      }),
    );
    if (resolution.status === "rejected") {
      throw new Error(`elicit resolution failed: ${resolution.code}`);
    }
    responses += 1;
    outcome = await activate(`live-owner-${round + 1}`);
  }
  if (outcome.state !== "completed") {
    throw new Error(`play_ttt did not complete: ${outcome.state}`);
  }
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
  const evidence = {
    releaseId: release.releaseId,
    runtimeArn: release.runtimeArn,
    runtimeSessionId: placement.runtimeSessionId,
    collectionDigest: collection.collectionDigest,
    exactProgramArtifactDigest: program.digest,
    modelSamples,
    elicitResponses: responses,
    journalRecordTypes: authority.readJournal(sessionId).map((record) => record.payload.type),
    durationMs: Date.now() - started,
    completed: true,
    certifiedAt: new Date().toISOString(),
  };
  await writeFile(
    `live-evidence/${release.releaseId}-development-play-ttt.json`,
    JSON.stringify(evidence, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(evidence));
}

function firstEmptyPosition(messages: unknown): number {
  const match = /Empty positions:\s*([0-8](?:,\s*[0-8])*)/u.exec(JSON.stringify(messages));
  return Number(match?.[1]?.split(",")[0] ?? 0);
}

function containsGameOver(value: Json): boolean {
  if (Array.isArray(value)) {
    return value.some(containsGameOver);
  }
  if (value && typeof value === "object") {
    if (value["gameOver"] === true) {
      return true;
    }
    return Object.values(value).some(containsGameOver);
  }
  return false;
}

function firstEmptyBoardPosition(value: Json): number {
  if (Array.isArray(value)) {
    if (
      value.length === 9 &&
      value.every((cell) => cell === null || cell === "X" || cell === "O")
    ) {
      return value.findIndex((cell) => cell === null);
    }
    for (const child of value) {
      const found = firstEmptyBoardPosition(child);
      if (found >= 0) {
        return found;
      }
    }
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      const found = firstEmptyBoardPosition(child);
      if (found >= 0) {
        return found;
      }
    }
  }
  return -1;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

void main();
