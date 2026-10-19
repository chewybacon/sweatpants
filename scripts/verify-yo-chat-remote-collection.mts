import { resolve } from "node:path";

import config from "../apps/yo-chat/sweatpants.config.ts";
import {
  bundleConfiguredPrograms,
  loadCollectionProgramEntries,
} from "../packages/cli/src/remote-development.ts";

async function main(): Promise<void> {
  const built = await bundleConfiguredPrograms({
    projectRoot: resolve(process.cwd(), "apps/yo-chat"),
    programs: config.programs,
    builderVersion: "0.1.0",
    evaluatorAbi: "agentcore-development-v1",
    platform: `${process.platform}-${process.arch}`,
    allowedEvaluatorImports: ["node:process"],
  });

  const programs = await loadCollectionProgramEntries(built.manifest, built.files);
  if (!programs.has("play_ttt")) {
    throw new Error("Real play_ttt program was not reconstructed from the collection");
  }

  console.log(
    JSON.stringify({
      collectionDigest: built.manifest.collectionDigest,
      programs: Object.keys(built.manifest.programs),
      bytes: built.archiveBytes.byteLength,
    }),
  );
}

void main();
