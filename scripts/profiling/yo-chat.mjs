import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { summarizeProfile } from "./summarize-profile.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runs = Number(process.argv[2] ?? 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) {
  throw new Error("Usage: pnpm profile:yo-chat [runs: 1–100]");
}
const output = join(root, ".artifacts", "profiles", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const frozenBundle = process.env.YO_CHAT_CPU_PROFILE_BUNDLE
  ? resolve(process.env.YO_CHAT_CPU_PROFILE_BUNDLE)
  : undefined;
const frozenSchema = process.env.YO_CHAT_CPU_PROFILE_SCHEMA
  ? resolve(process.env.YO_CHAT_CPU_PROFILE_SCHEMA)
  : undefined;
const metadata = {
  scenario:
    "^worker conversation host.*replays a parked card after the entire Worker host is replaced$",
  runs,
  frozenBundle: frozenBundle ?? null,
  frozenSchema: frozenSchema ?? null,
  frozenSchemaSha256: frozenSchema
    ? createHash("sha256")
        .update(await readFile(frozenSchema))
        .digest("hex")
    : null,
  frozenBundleSha256: frozenBundle
    ? createHash("sha256")
        .update(await readFile(frozenBundle))
        .digest("hex")
    : null,
  node: process.version,
  commit: git("rev-parse", "HEAD"),
  status: git("status", "--short"),
  trackedDiffSha256: createHash("sha256").update(git("diff", "HEAD")).digest("hex"),
  lockfileSha256: createHash("sha256")
    .update(await readFile(join(root, "pnpm-lock.yaml")))
    .digest("hex"),
  samplingIntervalMicroseconds: 100,
  note: "Local sampled active time, not Cloudflare billed CPU. Initial = send to park; restarted = restore, select, complete, recall. Startup and schema initialization excluded. Fresh storage per repetition; card values and IDs vary.",
};
await writeFile(join(output, "metadata.json"), JSON.stringify(metadata, null, 2));
const summaries = [];
for (let run = 1; run <= runs; run++) {
  const directory = join(output, `run-${run}`);
  await mkdir(directory);
  console.log(`Card scenario ${run}/${runs}`);
  const result = spawnSync(
    "pnpm",
    [
      "-C",
      "apps/yo-chat",
      "exec",
      "vitest",
      "run",
      "acceptance/cloudflare-host.acceptance.test.ts",
      "-t",
      metadata.scenario,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        /* CONDITIONAL-SPREAD: Preserve the inherited environment when YO_CHAT_CPU_PROFILE_BUNDLE has no override. */
        ...(frozenBundle ? { YO_CHAT_CPU_PROFILE_BUNDLE: frozenBundle } : {}),
        YO_CHAT_CPU_PROFILE_DIRECTORY: directory,
      },
    },
  );
  await writeFile(join(directory, "test.log"), (result.stdout ?? "") + (result.stderr ?? ""));
  if (result.error || result.status !== 0) {
    throw new Error(`Scenario failed; see ${directory}/test.log`, { cause: result.error });
  }
  for (const phase of ["initial", "restarted"]) {
    const profile = JSON.parse(await readFile(join(directory, `${phase}.cpuprofile`), "utf8"));
    const summary = { run, phase, ...summarizeProfile(profile) };
    summaries.push(summary);
    console.log(`  ${phase}: ${summary.activeMs.toFixed(1)} ms sampled active CPU`);
  }
}
const phases = ["initial", "restarted"].map((phase) => {
  const values = summaries
    .filter((item) => item.phase === phase)
    .map((item) => item.activeMs)
    .toSorted((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    phase,
    medianMs: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    minMs: values[0],
    maxMs: values.at(-1),
  };
});
await writeFile(join(output, "summary.json"), JSON.stringify({ phases, runs: summaries }, null, 2));
console.table(phases);
console.log(`Profiles and worker source: ${output}`);
