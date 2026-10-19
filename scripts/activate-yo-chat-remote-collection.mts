import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AwsS3ActiveCollectionStore,
  AwsS3VersionedObjectStore,
  activateReadyCollection,
  createAwsS3Client,
  verifyCollectionReadiness,
  type PublishedCollectionRefV1,
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
const evaluatorAbi = "agentcore-development-v1";

async function main(): Promise<void> {
  if (process.env["APPROVE_AGENTCORE_PAID_INVOCATION"] !== "yes") {
    throw new Error("Set APPROVE_AGENTCORE_PAID_INVOCATION=yes after explicit approval");
  }
  const deployment = JSON.parse(
    await readFile(
      "apps/agentcore-durable-program-runtime/agentcore-remote-development-deploy-output.json",
      "utf8",
    ),
  ) as { releaseId: string };
  const collection = JSON.parse(required("PUBLISHED_COLLECTION_JSON")) as PublishedCollectionRefV1;
  const client = createAwsS3Client(environment.region);
  const objects = new AwsS3VersionedObjectStore(client);
  const records = new AwsS3ActiveCollectionStore(
    client,
    bucket,
    `${prefix}/control/active-collection.json`,
  );
  const readiness = await verifyCollectionReadiness({
    store: objects,
    collection,
    evaluatorReleaseId: deployment.releaseId,
    evaluatorAbi,
  });
  const expected = await records.read(environment);
  const activated = await activateReadyCollection({
    store: records,
    environment,
    writerId: `dev-${randomUUID()}`,
    expected,
    readiness,
  });
  console.log(JSON.stringify(activated));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

void main();
