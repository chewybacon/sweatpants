import { resolve } from "node:path";

import config from "../apps/yo-chat/sweatpants.config.ts";
import {
    AwsS3VersionedObjectStore,
    bundleConfiguredPrograms,
    createAwsS3Client,
    publishDevelopmentCollection,
    verifyCollectionReadiness,
} from "../packages/cli/src/remote-development.ts";

const region = "us-east-1";
const bucket = "sweatpants-remote-development-988857891049-us-east-1";
const prefix = "sweatpants-rrauh-dev-f9fdea17fddb75da";
const evaluatorAbi = "agentcore-development-v1";

async function main(): Promise<void> {
    if (process.env["APPROVE_AGENTCORE_PAID_INVOCATION"] !== "yes") {
        throw new Error(
            "Set APPROVE_AGENTCORE_PAID_INVOCATION=yes after explicit paid-cloud approval",
        );
    }
    const built = await bundleConfiguredPrograms({
        projectRoot: resolve(process.cwd(), "apps/yo-chat"),
        programs: config.programs,
        builderVersion: "0.1.0",
        evaluatorAbi,
        platform: "linux-arm64",
        allowedEvaluatorImports: ["node:process"],
    });
    const store = new AwsS3VersionedObjectStore(createAwsS3Client(region));
    const published = await publishDevelopmentCollection({
        store,
        bucket,
        key: `${prefix}/collections/${built.manifest.collectionDigest}.json`,
        archiveBytes: built.archiveBytes,
        manifest: built.manifest,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    });
    await verifyCollectionReadiness({
        store,
        collection: published,
        evaluatorReleaseId: "local-preflight-only",
        evaluatorAbi,
    });
    console.log(JSON.stringify(published));
}

void main();
