import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Match yo-chat: build dependencies, refresh real credentials, initialize D1, then Astro.
function command(args: string[], env = process.env, cwd?: string) {
  const result = spawnSync("pnpm", args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed (${result.signal ?? result.status})`);
  }
}
command(["kernel:check"]);
command([
  "--filter",
  "yo-tisyn^...",
  "--workspace-concurrency=3",
  "--aggregate-output",
  "run",
  "build",
]);
const provider = process.env.DEFAULT_CHAT_MODEL_PROVIDER ?? "opencode";
const model = process.env.DEFAULT_CHAT_MODEL_ID ?? "claude-haiku-5-5";
command(["model:auth:refresh", "--provider", provider], process.env, "../..");
const { FileCredentialStore } = await import("@sweatpants/model-provider-pi-ai");
const credential = await new FileCredentialStore().read(provider);
if (!credential) {
  throw new Error(`No credential for ${provider}`);
}
mkdirSync(".wrangler", { recursive: true });
const secretFile = ".wrangler/yo-tisyn-signing-secret";
if (!existsSync(secretFile)) {
  writeFileSync(secretFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
}
const env = {
  ...process.env,
  MODEL_CREDENTIALS: JSON.stringify({ [provider]: credential }),
  PROGRAM_DRIVER_CAPABILITY_SECRET: readFileSync(secretFile, "utf8"),
  DEFAULT_CHAT_MODEL_PROVIDER: provider,
  DEFAULT_CHAT_MODEL_ID: model,
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
};
command(["exec", "tsx", "scripts/prepare-cloudflare.ts"], env);
console.log("Starting yo-tisyn on :8103 with OpenCode / Haiku 5.5.");
command(
  [
    "exec",
    "astro",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    "8103",
    "--strictPort",
    ...process.argv.slice(2),
  ],
  env,
);
