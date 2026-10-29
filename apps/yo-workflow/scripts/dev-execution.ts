import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// Local Execution lab only: no model credentials or external effects are needed.
mkdirSync(".wrangler", { recursive: true });
const secretFile = ".wrangler/execution-demo-secret";
if (!existsSync(secretFile)) {
  writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
}
const env = {
  ...process.env,
  NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
  MODEL_CREDENTIALS: "{}",
  PROGRAM_DRIVER_CAPABILITY_SECRET: readFileSync(secretFile, "utf8"),
  DEFAULT_CHAT_MODEL_PROVIDER: "opencode",
  DEFAULT_CHAT_MODEL_ID: "claude-haiku-5-5",
  DEFAULT_CHAT_MODEL_THINKING: "off",
  WORKFLOW_LOCAL_STATE_PATH: ".wrangler/execution-demo-state",
  WORKFLOW_DEV_PORT: process.env.WORKFLOW_DEV_PORT ?? "8110",
};
for (const args of [
  ["exec", "tsx", "scripts/prepare-cloudflare.ts"],
  [
    "exec",
    "astro",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    env.WORKFLOW_DEV_PORT,
    "--strictPort",
    "--ignore-lock",
  ],
]) {
  const result = spawnSync("pnpm", args, { env, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw Error(`Execution demo command failed: ${result.status}`);
  }
}
