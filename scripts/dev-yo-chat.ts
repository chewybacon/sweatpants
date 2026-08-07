import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "github-copilot";
const model = process.env["DEFAULT_CHAT_MODEL_ID"] ?? "gpt-5.5";

function runPnpmTask(task: string): void {
  const result = spawnSync("pnpm", [task], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function launch(): void {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DEFAULT_CHAT_MODEL_PROVIDER: provider,
    DEFAULT_CHAT_MODEL_ID: model,
  };

  if (provider === "github-copilot") {
    console.log("Refreshing GitHub Copilot credentials before starting yo-chat...");
    runPnpmTask("copilot:auth:refresh");
    runPnpmTask("copilot:auth:sync");
    // Prefer the freshly synced .env.local/auth file over a stale token that
    // may have been exported by an older shell session.
    delete childEnv.COPILOT_GITHUB_TOKEN;
  }

  console.log(`Starting yo-chat with ${provider}/${model}`);
  const child = spawn("pnpm", ["-C", "apps/yo-chat", "dev", ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: childEnv,
    stdio: "inherit",
  });

  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    console.error(`yo-chat failed to start: ${error.message}`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

try {
  launch();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Run `pnpm copilot:auth:login` if no refresh credential is available.");
  process.exit(1);
}
