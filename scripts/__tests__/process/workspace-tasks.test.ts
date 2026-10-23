import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const scripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts;
const tsx = createRequire(import.meta.url).resolve("tsx");
const temporary: string[] = [];
const tasks = ["lint", "format", "build", "check", "test", "dev", "build:clean"];

afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workspace-tasks-"));
  temporary.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true, scripts }),
  );
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "members/*"\n');
  for (const name of ["one", "two"]) {
    const directory = join(root, "members", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: `@fixture/${name}`,
        scripts: Object.fromEntries(tasks.map((task) => [task, `node task.mjs ${task}`])),
      }),
    );
    writeFileSync(
      join(directory, "task.mjs"),
      `
      import { appendFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      const task = process.argv[2];
      appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify({ name: ${JSON.stringify(name)}, task, args: process.argv.slice(3) }) + '\\n');
      if (task === 'build:clean') {
        const result = spawnSync(process.execPath, ['--import', ${JSON.stringify(tsx)}, ${JSON.stringify(join(repo, "scripts/clean-build.ts"))}, '.'], { stdio: 'inherit' });
        process.exit(result.status ?? 1);
      }
    `,
    );
  }
  return root;
}

function run(root: string, args: string[]) {
  const result = spawnSync("pnpm", args, { cwd: root, encoding: "utf8", timeout: 20_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return readFileSync(join(root, "calls"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

it.each(tasks.slice(0, 6))("fans unfiltered %s out to each workspace exactly once", (task) => {
  const root = fixture();

  const calls = run(root, [task]);

  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.name).sort()).toEqual(["one", "two"]);
  expect(calls.every((call) => call.task === task)).toBe(true);
});

it("uses pnpm filters to select one workspace and preserves forwarded arguments", () => {
  const root = fixture();

  const calls = run(root, ["--filter", "@fixture/one", "check", "two words"]);

  expect(calls).toEqual([{ name: "one", task: "check", args: ["two words"] }]);
});

it("cleans only the selected workspace while preserving source and dependencies", () => {
  const root = fixture();
  for (const name of ["one", "two"]) {
    for (const output of ["dist", ".tsup", "node_modules"]) {
      mkdirSync(join(root, "members", name, output));
      writeFileSync(join(root, "members", name, output, "keep.txt"), "fixture");
    }
    writeFileSync(join(root, "members", name, "tsconfig.tsbuildinfo"), "cache");
  }

  run(root, ["--filter", "@fixture/one", "build:clean"]);

  expect(() => readFileSync(join(root, "members/one/dist/keep.txt"))).toThrow();
  expect(() => readFileSync(join(root, "members/one/.tsup/keep.txt"))).toThrow();
  expect(() => readFileSync(join(root, "members/one/tsconfig.tsbuildinfo"))).toThrow();
  expect(readFileSync(join(root, "members/one/node_modules/keep.txt"), "utf8")).toBe("fixture");
  expect(readFileSync(join(root, "members/two/dist/keep.txt"), "utf8")).toBe("fixture");
  expect(readFileSync(join(root, "members/one/task.mjs"), "utf8")).toContain("appendFileSync");
});

it("keeps root tasks within seven namespaces and land exclusively at root", () => {
  const namespaces = new Set(["lint", "format", "build", "check", "test", "dev", "land"]);
  expect(Object.keys(scripts).filter((task) => !namespaces.has(task.split(":")[0]!))).toEqual([]);
  const members = [
    "acceptance",
    "scripts",
    ...["packages", "apps"].flatMap((parent) =>
      readdirSync(join(repo, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`),
    ),
  ];
  for (const member of members) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(repo, member, "package.json"), "utf8"));
    } catch {
      continue;
    }
    expect(
      Object.keys(manifest.scripts ?? {}).filter(
        (task) => task === "land" || task.startsWith("land:"),
      ),
      member,
    ).toEqual([]);
  }
});
