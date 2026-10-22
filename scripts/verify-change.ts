import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptanceLanes,
  selectVerification,
  verificationEnvironment,
  type WorkspaceProject,
} from "./verification.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Command {
  label: string;
  args: string[];
  workers?: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const requested: string[] = [];
  let base = "HEAD";
  let planOnly = false;
  let testFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--plan") {
      planOnly = true;
    } else if (flag === "--help") {
      console.log(
        "pnpm verify:change [--base REF] [--package NAME_OR_DIRECTORY] [--test PATH] [--plan]",
      );
      console.log(
        "Default: staged, unstaged and untracked changes against HEAD, plus downstream consumers.",
      );
      console.log(
        "--package selects explicit roots; --test runs one file and its owning strict checks.",
      );
      return;
    } else if (flag === "--package" || flag === "--base" || flag === "--test") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      if (flag === "--package") {
        requested.push(value);
      } else if (flag === "--base") {
        base = value;
      } else {
        testFile = value;
      }
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (testFile && requested.length) {
    throw new Error("Use --test or --package, not both");
  }
  const projects: WorkspaceProject[] = [];
  for (const parent of ["packages", "apps"]) {
    for (const entry of readdirSync(resolve(root, parent), { withFileTypes: true })) {
      const directory = `${parent}/${entry.name}`;
      const manifest = resolve(root, directory, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) {
        continue;
      }
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      projects.push({
        name: pkg.name,
        directory,
        dependencies: Object.keys({
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.peerDependencies,
          ...pkg.optionalDependencies,
        }),
        scripts: pkg.scripts ?? {},
        testTypes: existsSync(resolve(root, directory, "tsconfig.test.json")),
      });
    }
  }
  const git = (...gitArgs: string[]) =>
    execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const paths =
    requested.length || testFile
      ? []
      : [
          ...git("diff", "--name-only", "--no-renames", "-z", base, "--"),
          ...git("ls-files", "--others", "--exclude-standard", "-z"),
        ];
  let selection = selectVerification(projects, [...new Set(paths)], requested);
  if (testFile) {
    testFile = relative(root, resolve(root, testFile));
    const owner = projects.find((p) => testFile!.startsWith(`${p.directory}/`));
    const isTest =
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(testFile) ||
      /\/__tests__\/[^/]+\.(?:mts|mjs)$/.test(testFile);
    if (!owner || !existsSync(resolve(root, testFile)) || !isTest) {
      throw new Error(
        "--test must name an existing workspace test file relative to the repository root",
      );
    }
    selection = { projects: [owner], broad: false, reasons: [] };
    console.log("Focused file verification: downstream suites are still owed before landing.");
  }
  const commands: Command[] = [];
  if (selection.broad) {
    console.log(selection.reasons.join("\n"));
    commands.push({ label: "Complete gate for shared/unmapped changes", args: ["land"] });
  } else if (selection.projects.length) {
    console.log(`Selected: ${selection.projects.map((p) => p.name).join(", ")}`);
    const workflowFixtures = selection.projects.some((p) =>
      ["@sweatpants/flowmode-runtime-scheme", "yo-workflow"].includes(p.name),
    );
    // pnpm orders the union of the selected projects and their transitive prerequisites.
    // Refresh dist before tests; no clean build and no assumption that workers use source exports.
    commands.push({
      label: "Build selected projects and prerequisites",
      args: [
        ...selection.projects.flatMap((p) => ["--filter", `${p.name}...`]),
        ...(workflowFixtures ? ["--filter", "yo-workflow^..."] : []),
        "--workspace-concurrency=3",
        "--aggregate-output",
        "--if-present",
        "run",
        "build",
      ],
    });
    if (workflowFixtures) {
      commands.push({
        label: "Build workflow fixtures",
        args: ["--filter", "yo-workflow", "execution:compile"],
      });
    }
    commands.push({
      label: "Type-aware lint",
      args: [
        "exec",
        "oxlint",
        "--type-aware",
        "--import-plugin",
        "--react-plugin",
        "--promise-plugin",
        "--vitest-plugin",
        ...selection.projects.map((p) => p.directory),
      ],
    });
    for (const project of selection.projects) {
      if (project.scripts["check"]) {
        commands.push({
          label: `Types: ${project.name}`,
          // tsup cleans tsc's emitted declaration paths without invalidating
          // project-reference build info. Rebuild those declarations explicitly.
          args: project.scripts["check"].startsWith("tsc -b")
            ? ["-C", project.directory, "exec", "tsc", "-b", "--force"]
            : ["-C", project.directory, "check"],
        });
        if (project.scripts["check"].startsWith("tsc -b ")) {
          commands.push({
            label: `Additional types: ${project.name}`,
            args: ["-C", project.directory, "check"],
          });
        }
      }
      if (project.testTypes) {
        commands.push({
          label: `Test types: ${project.name}`,
          args: ["check:tests", project.directory],
        });
      }
      if (project.scripts["lint"]) {
        commands.push({ label: `Lint: ${project.name}`, args: ["-C", project.directory, "lint"] });
      }
      commands.push({
        label: `Format: ${project.name}`,
        args: ["exec", "oxfmt", "--check", project.directory],
      });
      if (testFile) {
        const local = relative(project.directory, testFile);
        commands.push({
          label: `Test: ${testFile}`,
          args: /\.[cm][jt]s$/.test(local)
            ? ["-C", project.directory, "exec", "node", "--import", "tsx", "--test", local]
            : ["-C", project.directory, "exec", "vitest", "run", local, "--maxWorkers=1"],
        });
      } else if (project.name === "@sweatpants/platform-acceptance") {
        for (const lane of acceptanceLanes) {
          commands.push({
            label: `Acceptance: ${lane.name}`,
            args: ["-C", project.directory, `test:${lane.name}`],
            workers: lane.workers,
          });
        }
      } else if (project.scripts["test"]) {
        commands.push({ label: `Tests: ${project.name}`, args: ["-C", project.directory, "test"] });
      }
    }
    if (
      !testFile &&
      selection.projects.some((p) =>
        /flowmode|journal-authority|durable-execution|tool-runtime-local/.test(p.name),
      )
    ) {
      commands.push({ label: "Execution recovery", args: ["test:execution-recovery"] });
    }
  }
  if (!commands.length) {
    console.log("No changed inputs. Use --base or --package to select work.");
    return;
  }
  for (const command of commands) {
    console.log(`${command.label}: pnpm ${command.args.join(" ")}`);
  }
  if (planOnly) {
    console.log("Plan only; no checks executed.");
    return;
  }
  for (const command of commands) {
    console.log(`\n${command.label}`);
    await new Promise<void>((done, reject) => {
      const child = spawn("pnpm", command.args, {
        cwd: root,
        env: verificationEnvironment(command.workers),
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      let interrupted = false;
      const interrupt = () => {
        interrupted = true;
        if (child.pid) {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
        }
      };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      const cleanup = () => {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("exit", (code, signal) => {
        cleanup();
        if (code === 0 && !interrupted) {
          done();
        } else {
          reject(new Error(`${command.label} failed (${signal ?? code})`));
        }
      });
    });
  }
  console.log(
    selection.broad
      ? "Complete deterministic gate passed."
      : "Selected verification passed. Final verification still owed: pnpm land (and live checks when applicable).",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
