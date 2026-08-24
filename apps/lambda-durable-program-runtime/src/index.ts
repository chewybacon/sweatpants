import { randomUUID } from "node:crypto";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Context } from "aws-lambda";
import { run } from "effection";

import {
  decodeDevelopmentCollectionArchive,
  loadCollectionProgramEntries,
  type PublishedCollectionRefV1,
} from "@sweatpants/cli/remote-development-evaluator";
import {
  createDurableToolRegistry,
  exactProgramKey,
  type PinnedProgram,
  type ProgramCommand,
  type ProgramStep,
} from "@sweatpants/durable-execution";
import { createWorkflowProgramDriver } from "@sweatpants/journal-authority";
import { type Json } from "@sweatpants/foundation";

interface LambdaCrankRequestV1 {
  readonly protocolVersion: 1;
  readonly type: "evaluate_development_crank";
  readonly collection: PublishedCollectionRefV1;
  readonly publicKey: string;
  readonly taskId: string;
  readonly executionEpoch: number;
  readonly program: PinnedProgram;
  readonly input: Json;
  readonly commands: readonly ProgramCommand[];
}

interface LambdaCrankResponseV1 {
  readonly protocolVersion: 1;
  readonly type: "development_crank_result";
  readonly taskId: string;
  readonly executionEpoch: number;
  readonly step: ProgramStep;
  readonly computeGeneration: string;
  readonly replayedCommandCount: number;
}

interface LoadedCollection {
  readonly programs: Awaited<ReturnType<typeof loadCollectionProgramEntries>>;
}

const bucket = requiredEnvironment("SWEATPANTS_DEVELOPMENT_BUCKET");
const prefix = requiredEnvironment("SWEATPANTS_DEVELOPMENT_PREFIX");
const evaluatorAbi = requiredEnvironment("SWEATPANTS_EVALUATOR_ABI");
const s3 = new S3Client({ region: process.env["AWS_REGION"] ?? "us-east-1" });
const computeGeneration = randomUUID();
const cache = new Map<string, Promise<LoadedCollection>>();

export async function handler(
  event: LambdaCrankRequestV1,
  _context: Context,
): Promise<LambdaCrankResponseV1> {
  validateRequest(event);
  const loaded = await loadCollection(event.collection);
  const entry = loaded.programs.get(event.publicKey);
  if (
    !entry ||
    exactProgramKey(event.program) !==
      exactProgramKey({
        id: entry.manifest.programId,
        version: entry.manifest.version,
        digest: entry.manifest.digest,
      })
  ) {
    throw new Error("selected exact program is unavailable");
  }
  if (event.commands.length === 0 || event.commands[0]?.type !== "start") {
    throw new Error("crank transcript must begin with start");
  }
  const registry = createDurableToolRegistry(loaded.programs.values());
  const driver = createWorkflowProgramDriver(registry);
  const step = await run(function* () {
    const attachment = yield* driver.attach({
      sessionId: `lambda:${event.taskId}`,
      taskId: event.taskId,
      program: event.program,
      input: event.input,
      route: { driverKind: "program" },
      executionEpoch: event.executionEpoch,
    });
    let current: ProgramStep | undefined;
    try {
      for (const command of event.commands) {
        current = yield* driver.step(attachment, command);
      }
      if (!current) {
        throw new Error("crank transcript produced no step");
      }
      return current;
    } finally {
      yield* driver.shutdown(attachment, "scope_exit");
    }
  });
  return {
    protocolVersion: 1,
    type: "development_crank_result",
    taskId: event.taskId,
    executionEpoch: event.executionEpoch,
    step,
    computeGeneration,
    replayedCommandCount: event.commands.length,
  };
}

async function loadCollection(collection: PublishedCollectionRefV1): Promise<LoadedCollection> {
  validateCollectionReference(collection);
  const key = `${collection.key}\n${collection.versionId}\n${collection.objectDigest}`;
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }
  const loading = (async () => {
    const output = await s3.send(
      new GetObjectCommand({
        Bucket: collection.bucket,
        Key: collection.key,
        VersionId: collection.versionId,
      }),
    );
    if (output.VersionId !== collection.versionId || !output.Body) {
      throw new Error("exact collection object version is unavailable");
    }
    const bytes = Uint8Array.from(await output.Body.transformToByteArray());
    if (bytes.byteLength !== collection.bytes) {
      throw new Error("collection object size differs");
    }
    const built = decodeDevelopmentCollectionArchive(bytes, collection.objectDigest);
    if (
      built.manifest.collectionDigest !== collection.collectionDigest ||
      built.manifest.evaluatorAbi !== evaluatorAbi
    ) {
      throw new Error("collection identity or evaluator ABI differs");
    }
    return { programs: await loadCollectionProgramEntries(built.manifest, built.files) };
  })();
  cache.set(key, loading);
  try {
    return await loading;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

function validateRequest(value: LambdaCrankRequestV1): void {
  if (
    !value ||
    value.protocolVersion !== 1 ||
    value.type !== "evaluate_development_crank" ||
    !value.taskId ||
    !value.publicKey ||
    !Number.isSafeInteger(value.executionEpoch) ||
    value.executionEpoch <= 0 ||
    !Array.isArray(value.commands) ||
    value.commands.length > 256
  ) {
    throw new Error("invalid Lambda crank request");
  }
}

function validateCollectionReference(value: PublishedCollectionRefV1): void {
  if (
    value.format !== "sweatpants.published-collection.v1" ||
    value.bucket !== bucket ||
    !value.key.startsWith(`${prefix}/collections/`) ||
    !value.versionId ||
    !/^[0-9a-f]{64}$/u.test(value.objectDigest) ||
    !/^[0-9a-f]{64}$/u.test(value.collectionDigest)
  ) {
    throw new Error("collection reference is outside the Lambda development environment");
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
