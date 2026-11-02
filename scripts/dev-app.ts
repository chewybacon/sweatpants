import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apps = ["yo-chat", "yo-mcp"];

export function dependencyBuildArgs(app: string): string[] {
  if (!apps.includes(app)) {
    throw new Error(`Unknown development app: ${app}`);
  }
  // The trailing ^ excludes the app itself; pnpm orders the complete dependency graph.
  return [
    "--filter",
    `${app}^...`,
    "--workspace-concurrency=3",
    "--aggregate-output",
    "run",
    "build",
  ];
}

export function runCommand(
  args: string[],
  cwd = repoRoot,
  env: NodeJS.ProcessEnv = process.env,
  preparation = false,
): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("pnpm", args, {
      cwd,
      env,
      // Keep build output out of protocols carried on stdout.
      stdio: preparation ? ["inherit", 2, 2] : "inherit",
    });
    let stopped: NodeJS.Signals | undefined;
    const interrupt = () => {
      stopped = "SIGINT";
      child.kill("SIGINT");
    };
    const terminate = () => {
      stopped = "SIGTERM";
      child.kill("SIGTERM");
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const cleanup = () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (stopped || signal || code !== 0) {
        reject(new Error(`pnpm ${args.join(" ")} exited with ${stopped ?? signal ?? code}`));
      } else {
        resolveRun();
      }
    });
  });
}

export async function prepareApp(app: string): Promise<void> {
  const args = dependencyBuildArgs(app);
  console.error(`[${app}] Building workspace dependencies from current sources…`);
  await runCommand(args, repoRoot, process.env, true);
}

export async function launchApp(app: string, command: string[]): Promise<void> {
  if (!command.length) {
    throw new Error("A development command is required");
  }
  await prepareApp(app);
  console.error(`[${app}] Starting ${command.join(" ")}`);
  await runCommand(["exec", ...command], resolve(repoRoot, "apps", app));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [app = "", ...command] = process.argv.slice(2);
  launchApp(app, command).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
