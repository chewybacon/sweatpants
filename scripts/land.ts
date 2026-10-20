import { createConnection } from "node:net";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const mode = process.argv[2] ?? "deterministic";
  if (!new Set(["deterministic", "live", "full"]).has(mode)) {
    console.error("usage: pnpm land | pnpm land:live | pnpm land:full");
    process.exit(2);
  }

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const artifactDir = join(root, ".artifacts", "landing", `${stamp}-${mode}`);
  await mkdir(artifactDir, { recursive: true });

  const livePlaywrightPort = Number(process.env["LAND_LIVE_PLAYWRIGHT_PORT"] ?? "18111");
  const packageTestConcurrency = Number(process.env["LAND_PACKAGE_TEST_CONCURRENCY"] ?? "1");
  if (!Number.isSafeInteger(packageTestConcurrency) || packageTestConcurrency < 1) {
    throw new Error("LAND_PACKAGE_TEST_CONCURRENCY must be a positive integer");
  }
  const summary: RunSummary = { mode, startedAt: new Date().toISOString(), stages: [] };

  interface Stage {
    name: string;
    command: string;
    args: string[];
    timeoutMs: number;
    env?: Record<string, string>;
    forbidSkips?: boolean;
  }

  interface StageSummary {
    name: string;
    command: string;
    status: "passed" | "failed";
    durationMs: number;
    log: string;
    classification?: string;
  }

  interface RunSummary {
    mode: string;
    startedAt: string;
    completedAt?: string;
    status?: "passed" | "failed";
    stages: StageSummary[];
  }

  async function appTestStages(): Promise<Stage[]> {
    const stages: Stage[] = [];
    const parent = "apps";
    for (const directory of (await readdir(join(root, parent), { withFileTypes: true })).filter(
      (entry) => entry.isDirectory(),
    )) {
      const packageDir = join(root, parent, directory.name);
      let packageJson: { name?: string; scripts?: Record<string, string> };
      try {
        packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      const test = packageJson.scripts?.["test"];
      if (!test) {
        continue;
      }
      const label = packageJson.name ?? `${parent}/${directory.name}`;
      stages.push({
        name: `test:${label}`,
        command: "pnpm",
        args: ["-C", packageDir, "test"],
        timeoutMs: test.includes("playwright") ? 15 * 60_000 : 10 * 60_000,
        forbidSkips: test.includes("playwright") ? true : undefined,
      });
    }
    return stages;
  }

  function deterministicStages(appTests: Stage[]): Stage[] {
    return [
      { name: "types", command: "pnpm", args: ["check"], timeoutMs: 10 * 60_000 },
      { name: "lint", command: "pnpm", args: ["lint"], timeoutMs: 5 * 60_000 },
      // Package builds exclude tests from tsc so declarations stay clean, which
      // left test code unchecked entirely.
      { name: "types:tests", command: "pnpm", args: ["check:tests"], timeoutMs: 10 * 60_000 },
      // Fixture tests for the custom rules themselves: `lint` proves the repo
      // obeys them, this proves they still detect what they claim to.
      { name: "test:tooling", command: "pnpm", args: ["test:tooling"], timeoutMs: 5 * 60_000 },
      // Consumer-or-parked gate (no-sediment rule 5) and permanent source
      // evidence: deleted identities must stay deleted on every landing (REQ-013).
      // Campaign archive/reference checks run only through explicit closure.
      { name: "check:hygiene", command: "pnpm", args: ["check:hygiene"], timeoutMs: 2 * 60_000 },
      { name: "check:evidence", command: "pnpm", args: ["check:evidence"], timeoutMs: 2 * 60_000 },
      {
        name: "build:clean",
        command: "pnpm",
        args: ["verify:clean-build"],
        timeoutMs: 15 * 60_000,
      },
      // Apps resolve package exports from dist, so check them only after the
      // clean build has regenerated every dependency artifact.
      { name: "types:apps", command: "pnpm", args: ["check:apps"], timeoutMs: 10 * 60_000 },
      {
        name: "format:repository",
        command: "pnpm",
        args: ["format:check"],
        timeoutMs: 5 * 60_000,
      },
      {
        name: "verify:yo-chat-remote-collection",
        command: "pnpm",
        args: ["verify:yo-chat-remote-collection"],
        timeoutMs: 5 * 60_000,
      },
      {
        name: "test:packages",
        command: "pnpm",
        args: [
          "--filter",
          "./packages/**",
          "--filter",
          "!@sweatpants/platform-acceptance",
          `--workspace-concurrency=${packageTestConcurrency}`,
          "--aggregate-output",
          "run",
          "test",
        ],
        timeoutMs: 15 * 60_000,
      },
      // The normal and SQLite acceptance lanes take about ten minutes together.
      // Give them their own bounded stage instead of consuming the time left
      // after the rest of the dependency-ordered package suite.
      {
        name: "test:platform-acceptance",
        command: "pnpm",
        args: ["--filter", "@sweatpants/platform-acceptance", "test"],
        timeoutMs: 15 * 60_000,
      },
      // Real Hoot recovery uses built workspace packages and the Hoot artifact used by yo-workflow.
      // Run sequentially, after the clean build, alongside the normal regression gates.
      {
        name: "test:execution-recovery",
        command: "pnpm",
        args: ["test:execution-recovery"],
        timeoutMs: 5 * 60_000,
      },
      ...appTests,
    ];
  }

  function liveStages(): Stage[] {
    return [
      {
        name: "preflight:model-auth",
        command: "pnpm",
        args:
          process.env["DEFAULT_CHAT_MODEL_PROVIDER"] === "openai"
            ? ["exec", "tsx", "scripts/check-openai-connection.ts"]
            : ["model:auth:refresh"],
        timeoutMs: 30_000,
      },
      {
        name: "e2e:yo-chat:live",
        command: "pnpm",
        args: [
          "-C",
          "apps/yo-chat",
          "exec",
          "playwright",
          "test",
          "--max-failures=1",
          "--retries=0",
          "--reporter=line",
        ],
        timeoutMs: 20 * 60_000,
        env: { E2E_FULL: "1", PLAYWRIGHT_PORT: String(livePlaywrightPort) },
        forbidSkips: true,
      },
    ];
  }

  await preflight(mode);
  const appTests = mode === "live" ? [] : await appTestStages();
  const stages = [
    ...(mode === "live" ? [] : deterministicStages(appTests)),

    ...(mode === "deterministic" ? [] : liveStages()),
  ];

  const coverageBaselinePath = join(root, "scripts", "test-coverage-baseline.json");
  const coverageBaseline: Record<string, CoverageTotals> = await (async () => {
    try {
      return JSON.parse(await readFile(coverageBaselinePath, "utf8")) as Record<
        string,
        CoverageTotals
      >;
    } catch {
      return {};
    }
  })();
  const observedCoverage: Record<string, CoverageTotals> = {};
  const updateCoverageBaseline = process.env["LAND_UPDATE_COVERAGE_BASELINE"] === "1";

  console.log(`Landing mode: ${mode}`);
  console.log(`Artifacts: ${relativeArtifact(artifactDir)}`);
  console.log(`Stages: ${stages.length}\n`);

  for (const [index, stage] of stages.entries()) {
    console.log(`[${index + 1}/${stages.length}] ${stage.name}`);
    const result = await runStage(stage, index + 1);
    summary.stages.push(result);
    await persistSummary();
    if (result.status === "failed") {
      summary.status = "failed";
      summary.completedAt = new Date().toISOString();
      await persistSummary();
      process.exit(1);
    }
    console.log(`  PASS ${formatDuration(result.durationMs)}\n`);
  }

  summary.status = "passed";
  summary.completedAt = new Date().toISOString();
  await persistSummary();
  if (updateCoverageBaseline) {
    await writeFile(
      coverageBaselinePath,
      `${JSON.stringify({ ...coverageBaseline, ...observedCoverage }, undefined, 4)}\n`,
    );
    console.log(`Updated coverage baseline: scripts/test-coverage-baseline.json`);
  }

  console.log(`LAND PASSED in ${formatDuration(Date.now() - Date.parse(summary.startedAt))}`);
  console.log(`Summary: ${relativeArtifact(join(artifactDir, "summary.json"))}`);

  async function preflight(selectedMode: string): Promise<void> {
    if (
      !Number.isSafeInteger(packageTestConcurrency) ||
      packageTestConcurrency < 1 ||
      packageTestConcurrency > 8
    ) {
      failPreflight(
        "PREFLIGHT_CONCURRENCY_INVALID",
        `LAND_PACKAGE_TEST_CONCURRENCY must be an integer from 1 through 8; received ${packageTestConcurrency}`,
      );
    }
    const ports = selectedMode === "live" || selectedMode === "full" ? [livePlaywrightPort] : [];
    for (const port of ports) {
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        failPreflight("PREFLIGHT_PORT_INVALID", `Invalid isolated Playwright port: ${port}`);
      }
      if (await portIsOpen(port)) {
        failPreflight(
          "PREFLIGHT_PORT_OCCUPIED",
          `Isolated Playwright port ${port} is already occupied; choose LAND_PLAYWRIGHT_PORT/LAND_LIVE_PLAYWRIGHT_PORT`,
        );
      }
    }
  }

  async function portIsOpen(port: number): Promise<boolean> {
    return await new Promise((resolvePort) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (openPort: boolean) => {
        socket.destroy();
        resolvePort(openPort);
      };
      socket.setTimeout(250);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  }

  function failPreflight(classification: string, message: string): never {
    console.error(`LAND FAILED [${classification}]`);
    console.error(message);
    console.error("No test process was started.");
    process.exit(1);
  }

  async function runStage(stage: Stage, ordinal: number): Promise<StageSummary> {
    const started = Date.now();
    const logPath = join(
      artifactDir,
      `${String(ordinal).padStart(2, "0")}-${slug(stage.name)}.log`,
    );
    const log = await open(logPath, "w");
    const tail: string[] = [];
    let pending = "";
    let timedOut = false;
    const child = spawn(stage.command, stage.args, {
      cwd: root,
      env: {
        ...process.env,
        ...stage.env,
        // Package concurrency alone does not bound each Vitest worker pool.
        VITEST_MAX_THREADS: "1",
        VITEST_MIN_THREADS: "1",
        VITEST_MAX_FORKS: "1",
        VITEST_MIN_FORKS: "1",
        CI: "",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Stages have their own process group; forward interruption to descendants.
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      terminate(child.pid);
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const consume = (chunk: Buffer) => {
      void log.write(chunk);
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        tail.push(line);
        if (tail.length > 80) {
          tail.shift();
        }
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);

    const heartbeat = setInterval(() => {
      console.log(`  … ${formatDuration(Date.now() - started)}`);
    }, 30_000);
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate(child.pid);
    }, stage.timeoutMs);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
        child.once("error", () => resolveExit({ code: 1, signal: null }));
      },
    );
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    clearInterval(heartbeat);
    clearTimeout(timeout);
    if (pending) {
      tail.push(pending);
    }
    await log.close();
    if (interrupted) {
      console.error("Landing interrupted; terminated the active stage process group.");
      process.exit(130);
    }

    const fullLog = await readFile(logPath, "utf8");
    const skipped = stage.forbidSkips && hasSkippedTests(fullLog);
    const coverage = readCoverage(fullLog);
    if (coverage) {
      observedCoverage[stage.name] = coverage;
    }
    const coverageFailure =
      exit.code === 0 && coverage && !updateCoverageBaseline
        ? compareCoverage(stage.name, coverage, coverageBaseline[stage.name])
        : undefined;
    if (exit.code === 0 && !timedOut && !skipped && !coverageFailure) {
      return {
        name: stage.name,
        command: displayCommand(stage),
        status: "passed",
        durationMs: Date.now() - started,
        log: relativeArtifact(logPath),
      };
    }

    if (coverageFailure) {
      console.error(`\nLAND FAILED [COVERAGE_REGRESSION]`);
      console.error(coverageFailure);
      console.error(`Full log: ${relativeArtifact(logPath)}`);
      console.error(`Update deliberately with: LAND_UPDATE_COVERAGE_BASELINE=1 pnpm land`);
      process.exit(1);
    }

    const classification = timedOut
      ? "HARD_TIMEOUT"
      : skipped
        ? "SKIPPED_TESTS"
        : classifyFailure(fullLog);
    console.error(`\nLAND FAILED [${classification}]`);
    console.error(`Stage: ${stage.name}`);
    console.error(`Command: ${displayCommand(stage)}`);
    console.error(
      `Elapsed: ${formatDuration(Date.now() - started)} / budget ${formatDuration(stage.timeoutMs)}`,
    );
    console.error(`Full log: ${relativeArtifact(logPath)}`);
    console.error("\nBounded log tail (maximum 80 lines):");
    console.error(tail.slice(-80).join("\n"));
    console.error(`\nNext step: ${suggestion(classification, logPath)}`);
    console.error(
      "Do not increase the timeout or repeat this unchanged command without new evidence.",
    );

    return {
      name: stage.name,
      command: displayCommand(stage),
      status: "failed",
      durationMs: Date.now() - started,
      log: relativeArtifact(logPath),
      classification,
    };
  }

  function terminate(pid: number | undefined): void {
    if (!pid) {
      return;
    }
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
      } catch {}
    }, 2_000).unref();
  }

  interface CoverageTotals {
    passed: number;
    skipped: number;
    total: number;
  }

  /**
   * Sums the vitest summary lines in a stage log.
   *
   * A stage may aggregate many packages, so every `Tests …` line contributes.
   * Returns undefined when the stage produced no vitest summary at all, which is
   * how non-test stages opt out.
   */
  function readCoverage(rawLog: string): CoverageTotals | undefined {
    // Vitest colours its summary, so the counts are separated by escape
    // sequences rather than plain spaces.
    // eslint-disable-next-line no-control-regex
    const log = rawLog.replace(/\u001B\[[0-9;]*m/g, "");
    const pattern =
      /Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?(?:\s*\|\s*(\d+) todo)?\s*\((\d+)\)/g;
    let match: RegExpExecArray | null;
    let seen = false;
    const totals: CoverageTotals = { passed: 0, skipped: 0, total: 0 };
    while ((match = pattern.exec(log)) !== null) {
      seen = true;
      totals.passed += Number(match[1]);
      totals.skipped += Number(match[2] ?? 0);
      totals.total += Number(match[4]);
    }
    return seen ? totals : undefined;
  }

  /**
   * Compares a stage against its recorded coverage.
   *
   * This exists because "passed" is not the same as "ran". Deleting an import
   * once dropped a package from 507 to 449 collected tests while vitest still
   * printed a green summary, and 16 Redis-backed tests skip themselves silently
   * whenever Redis is absent. Both are invisible to an exit code.
   */
  function compareCoverage(
    stageName: string,
    actual: CoverageTotals,
    baseline: CoverageTotals | undefined,
  ): string | undefined {
    if (!baseline) {
      return undefined;
    }
    if (actual.total < baseline.total) {
      return (
        `${stageName}: collected ${actual.total} tests, baseline ${baseline.total}. ` +
        `Tests disappeared rather than failing — check for a broken import or a renamed file.`
      );
    }
    if (actual.skipped > baseline.skipped) {
      return (
        `${stageName}: ${actual.skipped} skipped, baseline ${baseline.skipped}. ` +
        `New skips hide coverage; run the required service or update the baseline deliberately.`
      );
    }
    return undefined;
  }

  function hasSkippedTests(log: string): boolean {
    return /(?:\b[1-9]\d*\s+skipped\b|\bskipped\s+[1-9]\d*\b)/i.test(log);
  }

  function classifyFailure(log: string): string {
    const value = log.toLowerCase();
    if (
      /\b401\b|\bunauthorized\b|authentication (?:failed|required)|auth(?:entication)? (?:failed|required)|token.*(?:expired|invalid)/.test(
        value,
      )
    ) {
      return "PROVIDER_AUTH_FAILED";
    }
    if (/eaddrinuse|address already in use|port .*occupied/.test(value)) {
      return "PORT_OCCUPIED";
    }
    if (/cannot find module|module_not_found|failed to resolve import/.test(value)) {
      return "MODULE_RESOLUTION_FAILED";
    }
    if (/assertionerror|expect\(|expected .* received|toequal|tocontain/.test(value)) {
      return "APPLICATION_ASSERTION";
    }
    if (/test timed out|timeout of \d+ms exceeded|timed out waiting/.test(value)) {
      return "TEST_TIMEOUT";
    }
    if (/econnrefused|enotfound|network error|fetch failed/.test(value)) {
      return "NETWORK_OR_SERVICE_UNAVAILABLE";
    }
    if (/typescript|error ts\d+/.test(value)) {
      return "TYPECHECK_FAILED";
    }
    return "TEST_PROCESS_FAILED";
  }

  function suggestion(classification: string, logPath: string): string {
    const log = relativeArtifact(logPath);
    switch (classification) {
      case "PROVIDER_AUTH_FAILED":
        return `refresh with \`pnpm model:auth:refresh\` (or login), then rerun once; details: ${log}`;
      case "PORT_OCCUPIED":
        return "identify the owning process or choose an isolated LAND_*_PLAYWRIGHT_PORT";
      case "APPLICATION_ASSERTION":
        return `inspect the failed assertion and trace artifact referenced near the end of ${log}`;
      case "TEST_TIMEOUT":
      case "HARD_TIMEOUT":
        return `look for the last progress event in ${log}; do not raise the timeout without evidence of forward progress`;
      case "SKIPPED_TESTS":
        return `remove or classify the skip; this e2e stage does not pass with skipped coverage (${log})`;
      default:
        return `inspect the bounded tail first, then search ${log} for the first error marker`;
    }
  }

  function displayCommand(stage: Stage): string {
    return [stage.command, ...stage.args].join(" ");
  }

  function relativeArtifact(path: string): string {
    return path.startsWith(root) ? path.slice(root.length + 1) : path;
  }

  function slug(value: string): string {
    return value.replaceAll(/[^a-zA-Z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  }

  function formatDuration(milliseconds: number): string {
    const seconds = Math.round(milliseconds / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  async function persistSummary(): Promise<void> {
    await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  }
}

void main().catch((error: unknown) => {
  console.error("LAND FAILED [ORCHESTRATOR_ERROR]");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
