import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";

interface Deployment {
  readonly releaseId: string;
  readonly agentRuntimeArn: string;
  readonly region: string;
}

interface PublishedCollection {
  readonly format: "sweatpants.published-collection.v1";
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly objectDigest: string;
  readonly collectionDigest: string;
  readonly bytes: number;
  readonly publishedAt: string;
  readonly expiresAt?: string;
}

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

async function main(): Promise<void> {
  if (process.env["APPROVE_AGENTCORE_PAID_INVOCATION"] !== "yes") {
    throw new Error("Set APPROVE_AGENTCORE_PAID_INVOCATION=yes after explicit approval");
  }
  const deployment = JSON.parse(
    await readFile("agentcore-remote-development-deploy-output.json", "utf8"),
  ) as Deployment;
  const collection = JSON.parse(required("PUBLISHED_COLLECTION_JSON")) as PublishedCollection;
  const client = new BedrockAgentCoreClient({ region: deployment.region });
  const runtimeSessionId = `readiness-${randomUUID()}`;
  try {
    const response = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: deployment.agentRuntimeArn,
        qualifier: "DEFAULT",
        runtimeSessionId,
        payload: Buffer.from(
          JSON.stringify({
            op: "development_collection_readiness",
            evaluatorAbi: "agentcore-development-v1",
            collection,
          }),
        ),
        contentType: "application/json",
        accept: "application/json",
      }),
    );
    const body = JSON.parse(await bodyToString(response.response)) as Record<string, unknown>;
    if (
      body["ready"] !== true ||
      body["collectionDigest"] !== collection.collectionDigest ||
      body["programCount"] !== 1
    ) {
      throw new Error(`Remote readiness failed: ${JSON.stringify(body)}`);
    }
    const evidence = {
      releaseId: deployment.releaseId,
      runtimeArn: deployment.agentRuntimeArn,
      runtimeSessionId,
      collectionDigest: collection.collectionDigest,
      objectDigest: collection.objectDigest,
      objectVersionId: collection.versionId,
      evaluatorAbi: body["evaluatorAbi"],
      programCount: body["programCount"],
      certifiedAt: new Date().toISOString(),
    };
    await writeFile(
      `live-evidence/${deployment.releaseId}-development-readiness.json`,
      JSON.stringify(evidence, null, 2),
      "utf8",
    );
    console.log(JSON.stringify(evidence));
  } finally {
    await client
      .send(
        new StopRuntimeSessionCommand({
          agentRuntimeArn: deployment.agentRuntimeArn,
          qualifier: "DEFAULT",
          runtimeSessionId,
          clientToken: randomUUID(),
        }),
      )
      .catch(() => undefined);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

void main();
