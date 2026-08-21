import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultModelForProvider,
  isYoChatAuthProvider,
  readStoredModelSelection,
} from "../packages/model-provider-pi-ai/src/auth.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stored = readStoredModelSelection();
const provider = process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? stored?.provider ?? "github-copilot";
const model =
  process.env["DEFAULT_CHAT_MODEL_ID"] ??
  (stored?.provider === provider ? stored.id : undefined) ??
  (isYoChatAuthProvider(provider) ? defaultModelForProvider(provider) : "gpt-5.5");

function runPnpmTask(task: string, args: readonly string[] = []): void {
  const result = spawnSync("pnpm", [task, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function launch(): void {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DEFAULT_CHAT_MODEL_PROVIDER: provider,
    DEFAULT_CHAT_MODEL_ID: model,
  };

  if (isYoChatAuthProvider(provider)) {
    console.log(`Checking ${provider} credentials before starting yo-chat...`);
    runPnpmTask("model:auth:refresh", ["--provider", provider]);
  }

  console.log(`Starting yo-chat with ${provider}/${model}`);
  const child = spawn("pnpm", ["-C", "apps/yo-chat", "dev", ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: childEnv,
    stdio: "inherit",
  });

  const forward = (signal: NodeJS.Signals): void => child.kill(signal);
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    console.error(`yo-chat failed to start: ${error.message}`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}

try {
  launch();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Run `pnpm model:auth:login --provider <provider>` to authenticate.");
  process.exit(1);
}
