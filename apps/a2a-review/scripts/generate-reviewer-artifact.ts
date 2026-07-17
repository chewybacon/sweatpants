import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = ["src/index.ts", "src/legacy.ts"] as const;
const hash = createHash("sha256").update("sweatpants.reference-reviewer.artifact.v1\n");
for (const path of sourceFiles) {
  const source = readFileSync(resolve(root, path), "utf8").replaceAll("\r\n", "\n");
  hash.update(`${path}\n${source.length}\n`).update(source);
}
const digest = hash.digest("hex");
const output = `/** Generated from ${sourceFiles.join(", ")}. Run pnpm generate:artifact after source changes. */\nexport const REFERENCE_REVIEWER_ARTIFACT_DIGEST =\n  "${digest}";\n`;
const target = resolve(root, "src/reviewer-artifact.generated.ts");

if (process.argv.includes("--write")) {
  writeFileSync(target, output);
  console.log(`wrote ${target}`);
} else {
  const current = readFileSync(target, "utf8");
  if (current !== output) {
    console.error("Reference reviewer artifact digest is stale; run pnpm generate:artifact");
    process.exit(1);
  }
}
