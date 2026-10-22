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

function fixture(dropMemoryCoverage: boolean) {
  const root = mkdtempSync(join(tmpdir(), "landing-verification-"));
  temporary.push(root);
  mkdirSync(join(root, "apps"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "scripts/test-coverage-baseline.json"),
    JSON.stringify({
      "test:platform-acceptance:memory": { passed: 102, total: 102, skipped: 0 },
    }),
  );
  // Stub only subprocess execution: the actual landing planner, worker environment,
  // collection accounting and summary persistence run in a fresh process.
  writeFileSync(
    join(root, "bin/pnpm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
console.log('POOL=' + process.env.VITEST_MAX_THREADS);
if (args.includes('test:memory')) console.log('Tests ${dropMemoryCoverage ? 1 : 102} passed (${dropMemoryCoverage ? 1 : 102})');
if (args.includes('test:tool-loop')) console.log('Tests 13 passed (13)');
if (args.includes('test:sqlite')) console.log('Tests 35 passed (35)');
if (args.includes('test:process')) console.log('Tests 9 passed (9)');
`,
    { mode: 0o755 },
  );
  return root;
}

it("uses four memory workers, restores one for SQLite/process, and keeps lanes separate", () => {
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
  const memory = summary.stages.find(
    (s: { name: string }) => s.name === "test:platform-acceptance:memory",
  );
  const sqlite = summary.stages.find(
    (s: { name: string }) => s.name === "test:platform-acceptance:sqlite",
  );
  const toolLoop = summary.stages.find(
    (s: { name: string }) => s.name === "test:platform-acceptance:tool-loop",
  );
  const processStage = summary.stages.find(
    (s: { name: string }) => s.name === "test:platform-acceptance:process",
  );
  expect(readFileSync(join(root, memory.log), "utf8")).toContain("POOL=4");
  expect(readFileSync(join(root, toolLoop.log), "utf8")).toContain("POOL=1");
  expect(readFileSync(join(root, sqlite.log), "utf8")).toContain("POOL=1");
  expect(readFileSync(join(root, processStage.log), "utf8")).toContain("POOL=1");
});

it("persists a failed coverage stage and stops before starting the next lane", () => {
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
    name: "test:platform-acceptance:memory",
    status: "failed",
    classification: "COVERAGE_REGRESSION",
  });
  expect(result.stdout).not.toContain("test:platform-acceptance:sqlite");
});
