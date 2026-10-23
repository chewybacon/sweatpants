import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const temporary: string[] = [];
const land = fileURLToPath(new URL("../../land.ts", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(dropAcceptanceCoverage: boolean) {
  const root = mkdtempSync(join(tmpdir(), "landing-verification-"));
  temporary.push(root);
  mkdirSync(join(root, "apps"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "scripts/test-coverage-baseline.json"),
    JSON.stringify({
      "test:acceptance": { passed: 111, total: 111, skipped: 0 },
    }),
  );
  // Stub only subprocess execution: the actual landing planner, worker environment,
  // collection accounting and summary persistence run in a fresh process.
  writeFileSync(
    join(root, "bin/pnpm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
console.log('POOL=' + process.env.VITEST_MAX_THREADS);
if (args.includes('test:acceptance')) console.log('Tests ${dropAcceptanceCoverage ? 1 : 111} passed (${dropAcceptanceCoverage ? 1 : 111})');
if (args.includes(process.env.FAIL_COMMAND)) process.exit(1);
`,
    { mode: 0o755 },
  );
  return root;
}

it("runs only lint, format, types and acceptance with a bounded worker budget", () => {
  const root = fixture(false);
  const result = spawnSync(process.execPath, ["--import", tsx, land, "deterministic"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      VITEST_MAX_THREADS: "99",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const run = join(root, ".artifacts/landing", readdirSync(join(root, ".artifacts/landing"))[0]!);
  const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
  expect(summary.status).toBe("passed");
  expect(summary.stages.map((stage: { command: string }) => stage.command)).toEqual([
    "pnpm lint",
    "pnpm format:check",
    "pnpm check:landing",
    "pnpm test:acceptance",
  ]);
  const acceptance = summary.stages.at(-1);
  expect(readFileSync(join(root, acceptance.log), "utf8")).toContain("POOL=1");
});

it("rejects acceptance collection regressions and persists the failed stage", () => {
  const root = fixture(true);
  const result = spawnSync(process.execPath, ["--import", tsx, land, "deterministic"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      LAND_UPDATE_COVERAGE_BASELINE: "0",
    },
  });
  expect(result.status).toBe(1);
  const run = join(root, ".artifacts/landing", readdirSync(join(root, ".artifacts/landing"))[0]!);
  const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
  expect(summary.status).toBe("failed");
  expect(summary.stages.at(-1)).toMatchObject({
    name: "test:acceptance",
    status: "failed",
    classification: "COVERAGE_REGRESSION",
  });
});

it("stops before acceptance when type checking fails", () => {
  const root = fixture(false);
  const result = spawnSync(process.execPath, ["--import", tsx, land, "deterministic"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      FAIL_COMMAND: "check:landing",
    },
  });
  expect(result.status).toBe(1);
  const run = join(root, ".artifacts/landing", readdirSync(join(root, ".artifacts/landing"))[0]!);
  const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
  expect(summary.stages.map((stage: { name: string }) => stage.name)).toEqual([
    "lint",
    "format:repository",
    "types",
  ]);
  expect(summary.stages.at(-1).status).toBe("failed");
});
