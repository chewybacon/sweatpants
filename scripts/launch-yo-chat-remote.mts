import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import config from "../apps/yo-chat/sweatpants.config.ts";
import {
  AwsS3ActiveCollectionStore,
  AwsS3VersionedObjectStore,
  createAwsS3Client,
  decodeDevelopmentCollectionArchive,
} from "../packages/cli/src/remote-development.ts";

const environment = {
  accountId: "123456789012",
  region: "us-east-1",
  project: "sweatpants",
  owner: "rrauh",
  name: "dev",
} as const;
const bucket = "sweatpants-remote-development-123456789012-us-east-1";
const prefix = "sweatpants-rrauh-dev-f9fdea17fddb75da";

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const deployment = JSON.parse(
    await readFile(
      resolve(
        root,
        "apps/agentcore-durable-program-runtime/agentcore-remote-development-deploy-output.json",
      ),
      "utf8",
    ),
  ) as {
    releaseId: string;
    registryDigest: string;
    agentRuntimeArn: string;
    imageUri: string;
    region: string;
    lifecycle: {
      idleRuntimeSessionTimeoutSeconds: number;
      maxLifetimeSeconds: number;
    };
  };
  const client = createAwsS3Client(environment.region);
  const activeStore = new AwsS3ActiveCollectionStore(
    client,
    bucket,
    `${prefix}/control/active-collection.json`,
  );
  const snapshot = await activeStore.read(environment);
  if (!snapshot.record) {
    throw new Error("The remote-development environment has no active collection");
  }
  if (snapshot.record.evaluatorReleaseId !== deployment.releaseId) {
    throw new Error("The active collection targets a different evaluator release");
  }
  const objects = new AwsS3VersionedObjectStore(client);
  const object = await objects.get(
    snapshot.record.collection.bucket,
    snapshot.record.collection.key,
    snapshot.record.collection.versionId,
  );
  const built = decodeDevelopmentCollectionArchive(
    object.bytes,
    snapshot.record.collection.objectDigest,
  );
  if (built.manifest.collectionDigest !== snapshot.record.collection.collectionDigest) {
    throw new Error("The active collection manifest differs from its control record");
  }
  const imageDigest = deployment.imageUri.split("@")[1];
  if (!imageDigest) {
    throw new Error("The evaluator deployment is not image-digest pinned");
  }
  const secret = await persistentProgramDriverSecret(root);
  const [command, ...arguments_] = config.app.command;
  console.log(
    JSON.stringify({
      event: "sweatpants.remote-development.launch",
      environment: `${environment.project}/${environment.owner}/${environment.name}`,
      runtimeArn: deployment.agentRuntimeArn,
      evaluatorReleaseId: deployment.releaseId,
      collectionDigest: built.manifest.collectionDigest,
      programs: Object.keys(built.manifest.programs),
    }),
  );
  const child = spawn(command, arguments_, {
    cwd: resolve(root, "apps/yo-chat", config.app.cwd ?? "."),
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      MCP_TOOL_RUNTIME: "agentcore",
      AGENTCORE_RUNTIME_ARN: deployment.agentRuntimeArn,
      AGENTCORE_REGION: deployment.region,
      AGENTCORE_DURABLE_RELEASE_ID: deployment.releaseId,
      AGENTCORE_DURABLE_IMAGE_DIGEST: imageDigest,
      AGENTCORE_DURABLE_REGISTRY_DIGEST: deployment.registryDigest,
      AGENTCORE_DURABLE_IAM_PROFILE: "sweatpants-remote-dev-f9fdea17-exec",
      AGENTCORE_DURABLE_NETWORK_PROFILE: "PUBLIC",
      AGENTCORE_DURABLE_IDLE_TIMEOUT_SECONDS: String(
        deployment.lifecycle.idleRuntimeSessionTimeoutSeconds,
      ),
      AGENTCORE_DURABLE_MAX_LIFETIME_SECONDS: String(deployment.lifecycle.maxLifetimeSeconds),
      AGENTCORE_DEVELOPMENT_ACTIVE_RECORD_JSON: JSON.stringify({
        record: snapshot.record,
        programs: built.manifest.programs,
      }),
      PROGRAM_DRIVER_CAPABILITY_SECRET: secret,
      DEFAULT_CHAT_MODEL_PROVIDER: process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "amazon-bedrock",
      DEFAULT_CHAT_MODEL_ID:
        process.env["DEFAULT_CHAT_MODEL_ID"] ?? "us.anthropic.claude-sonnet-4-6",
    },
  });
  const forward = (signal: NodeJS.Signals) => {
    if (child.killed || child.pid === undefined) {
      return;
    }
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );
  process.removeListener("SIGINT", forward);
  process.removeListener("SIGTERM", forward);
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exitCode = result.code ?? 1;
}

async function persistentProgramDriverSecret(root: string): Promise<string> {
  const directory = resolve(root, ".sweatpants");
  const path = resolve(directory, "program-driver-capability-secret");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // First run creates one stable local Host secret below.
  }
  const secret = randomBytes(32).toString("hex");
  await writeFile(path, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return secret;
}

void main();
