import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "src/index.ts"), "utf8").replaceAll("\r\n", "\n");
const digest = createHash("sha256")
  .update("sweatpants.reference-reviewer.artifact.v1\n")
  .update(source)
  .digest("hex");
const output = `/** Generated from src/index.ts. Run pnpm generate:artifact after source changes. */\nexport const REFERENCE_REVIEWER_ARTIFACT_DIGEST =\n  "${digest}";\n`;
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
