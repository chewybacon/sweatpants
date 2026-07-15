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

  const playwrightPort = Number(process.env["LAND_PLAYWRIGHT_PORT"] ?? "18110");
  const livePlaywrightPort = Number(process.env["LAND_LIVE_PLAYWRIGHT_PORT"] ?? "18111");
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

  async function packageTestStages(): Promise<Stage[]> {
    const stages: Stage[] = [];
    for (const parent of ["packages", "apps"]) {
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
        if (test.includes("vitest")) {
          stages.push({
            name: `test:${label}`,
            command: "pnpm",
            args: ["-C", packageDir, "exec", "vitest", "run", "--bail=1", "--passWithNoTests"],
            timeoutMs: 10 * 60_000,
          });
        } else if (test.includes("playwright")) {
          stages.push({
            name: `test:${label}`,
            command: "pnpm",
            args: [
              "-C",
              packageDir,
              "exec",
              "playwright",
              "test",
              "--max-failures=1",
              "--retries=0",
              "--reporter=line",
            ],
            timeoutMs: 15 * 60_000,
            forbidSkips: true,
          });
        } else {
          stages.push({
            name: `test:${label}`,
            command: "pnpm",
            args: ["-C", packageDir, "test"],
            timeoutMs: 10 * 60_000,
          });
        }
      }
    }
    return stages;
  }

  function deterministicStages(packageTests: Stage[]): Stage[] {
    return [
      {
        name: "generated",
        command: "pnpm",
        args: ["verify:generated"],
        timeoutMs: 2 * 60_000,
      },
      { name: "types", command: "pnpm", args: ["check"], timeoutMs: 10 * 60_000 },
      { name: "lint", command: "pnpm", args: ["lint"], timeoutMs: 5 * 60_000 },
      { name: "build", command: "pnpm", args: ["build"], timeoutMs: 15 * 60_000 },
      ...packageTests,
      {
        name: "e2e:yo-chat:deterministic",
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
        timeoutMs: 10 * 60_000,
        env: { PLAYWRIGHT_PORT: String(playwrightPort) },
        forbidSkips: true,
      },
    ];
  }

  function liveStages(): Stage[] {
    return [
      {
        name: "preflight:copilot-auth",
        command: "pnpm",
        args: ["copilot:auth:status"],
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
  const packageTests = mode === "live" ? [] : await packageTestStages();
  const stages = [
    ...(mode === "live" ? [] : deterministicStages(packageTests)),
    ...(mode === "deterministic" ? [] : liveStages()),
  ];

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
  console.log(`LAND PASSED in ${formatDuration(Date.now() - Date.parse(summary.startedAt))}`);
  console.log(`Summary: ${relativeArtifact(join(artifactDir, "summary.json"))}`);

  async function preflight(selectedMode: string): Promise<void> {
    const deterministicPorts = [playwrightPort, 3001, 6274];
    const ports =
      selectedMode === "live"
        ? [livePlaywrightPort]
        : selectedMode === "full"
          ? [...deterministicPorts, livePlaywrightPort]
          : deterministicPorts;
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
      env: { ...process.env, ...stage.env, CI: "" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    clearInterval(heartbeat);
    clearTimeout(timeout);
    if (pending) {
      tail.push(pending);
    }
    await log.close();

    const fullLog = await readFile(logPath, "utf8");
    const skipped = stage.forbidSkips && hasSkippedTests(fullLog);
    if (exit.code === 0 && !timedOut && !skipped) {
      return {
        name: stage.name,
        command: displayCommand(stage),
        status: "passed",
        durationMs: Date.now() - started,
        log: relativeArtifact(logPath),
      };
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

  function hasSkippedTests(log: string): boolean {
    return /(?:\b[1-9]\d*\s+skipped\b|\bskipped\s+[1-9]\d*\b)/i.test(log);
  }

  function classifyFailure(log: string): string {
    const value = log.toLowerCase();
    if (/401|unauthorized|authentication|token.*expired|token.*invalid/.test(value)) {
      return "PROVIDER_AUTH_FAILED";
    }
    if (/eaddrinuse|address already in use|port .*occupied/.test(value)) {
      return "PORT_OCCUPIED";
    }
    if (/generated.*stale|generated files.*differ|verify:generated/.test(value)) {
      return "GENERATED_ARTIFACTS_STALE";
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
        return `refresh with \`pnpm copilot:auth:refresh\` (or login), then rerun once; details: ${log}`;
      case "PORT_OCCUPIED":
        return "identify the owning process or choose an isolated LAND_*_PLAYWRIGHT_PORT";
      case "GENERATED_ARTIFACTS_STALE":
        return "run the documented generator once, then rerun the failed stage once";
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
