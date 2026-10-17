import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decisionBinding } from "../src/workflow/decisions.ts";
import { modelOptions } from "./model-options.ts";
import { createTisynModels } from "../src/server/cloudflare/model-catalog.ts";

const options = modelOptions(process.argv.slice(2));
if (options.help) {
  console.log(`Usage: pnpm dev:cloudflare [--provider opencode|github-copilot] [--model ID]
  [--thinking off|minimal|low|medium|high|xhigh] [--list-models] [--port PORT] [Astro options]
Defaults: opencode / claude-haiku-5-5 / medium. Copilot defaults to gpt-6.1-sol.
Examples:
  pnpm dev:cloudflare --provider github-copilot --model gpt-6.1-sol
  pnpm dev:cloudflare --provider github-copilot --model claude-opus-5.5 --port 8104
  pnpm dev:cloudflare --provider github-copilot --list-models`);
  process.exit(0);
}

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
if (!options.listModels) {
  command(["kernel:check"]);
  command(["scheme:check"]);
  command([
    "--filter",
    "yo-workflow^...",
    "--workspace-concurrency=3",
    "--aggregate-output",
    "run",
    "build",
  ]);
}
const { provider, model, thinking } = options;
command(["model:auth:refresh", "--provider", provider], process.env, "../..");
const { FileCredentialStore } = await import("@sweatpants/model-provider-pi-ai");
const credentials = new FileCredentialStore();
const credential = await credentials.read(provider);
if (!credential) {
  throw new Error(`No credential for ${provider}`);
}
const models = createTisynModels(credentials);
const available = await models.getAvailable(provider);
const selectedModels = available.filter((item) => item.provider === provider);
if (options.listModels) {
  for (const item of selectedModels) {
    console.log(`${item.id} (${item.api}; reasoning: ${item.reasoning})`);
  }
  process.exit(0);
}
if (!selectedModels.some((item) => item.id === model)) {
  throw new Error(
    `Model ${provider}/${model} is not available. Use --provider ${provider} --list-models.`,
  );
}
// Decisions have their own binding even when the authoring/sampling model changes.
const decisionCredential = await credentials.read(decisionBinding.provider);
if (!decisionCredential) {
  throw new Error(`No credential for decision provider ${decisionBinding.provider}`);
}
mkdirSync(".wrangler", { recursive: true });
const secretFile = ".wrangler/yo-tisyn-signing-secret";
if (!existsSync(secretFile)) {
  writeFileSync(secretFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
}
const env = {
  ...process.env,
  MODEL_CREDENTIALS: JSON.stringify({
    [decisionBinding.provider]: decisionCredential,
    [provider]: credential,
  }),
  PROGRAM_DRIVER_CAPABILITY_SECRET: readFileSync(secretFile, "utf8"),
  DEFAULT_CHAT_MODEL_PROVIDER: provider,
  DEFAULT_CHAT_MODEL_ID: model,
  DEFAULT_CHAT_MODEL_THINKING: thinking,
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
  WORKFLOW_DEV_PORT: options.port,
};
command(["exec", "tsx", "scripts/prepare-cloudflare.ts"], env);
console.log(`Starting yo-workflow with ${provider} / ${model}; reasoning: ${thinking}.`);
command(
  [
    "exec",
    "astro",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    options.port,
    "--strictPort",
    ...options.astroArgs,
  ],
  env,
);
