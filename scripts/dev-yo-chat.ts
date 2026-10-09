import { resolve } from "node:path";
import { readMode } from "./dev-options.ts";
import { prepareApp, repoRoot, runCommand } from "./dev-app.ts";
import {
  FileCredentialStore,
  defaultModelForProvider,
  isYoChatAuthProvider,
  readStoredModelSelection,
} from "../packages/model-provider-pi-ai/src/auth.ts";

const stored = readStoredModelSelection();
const provider = process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? stored?.provider ?? "github-copilot";
const model =
  process.env["DEFAULT_CHAT_MODEL_ID"] ??
  (stored?.provider === provider ? stored.id : undefined) ??
  (isYoChatAuthProvider(provider) ? defaultModelForProvider(provider) : "gpt-5.5");

async function launch(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = readMode(args);
  await prepareApp("yo-chat");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DEFAULT_CHAT_MODEL_PROVIDER: provider,
    DEFAULT_CHAT_MODEL_ID: model,
  };

  if (isYoChatAuthProvider(provider)) {
    console.log(`Checking ${provider} credentials before starting yo-chat...`);
    await runCommand(["model:auth:refresh", "--provider", provider]);
  }

  if (mode === "cloudflare") {
    const placement = process.env.CHAT_HOST_PLACEMENT ?? "durable-object";
    if (placement !== "worker" && placement !== "durable-object") {
      throw new Error(`Invalid CHAT_HOST_PLACEMENT: ${placement}`);
    }
    childEnv.CHAT_HOST_PLACEMENT = placement;
    const credential = await new FileCredentialStore().read(provider);
    if (!credential) {
      throw new Error(`No stored credential for ${provider}`);
    }
    childEnv.MODEL_CREDENTIALS = JSON.stringify({ [provider]: credential });
    childEnv.CLOUDFLARE_INCLUDE_PROCESS_ENV = "true";
    await runCommand(
      ["exec", "tsx", "scripts/prepare-cloudflare.ts"],
      resolve(repoRoot, "apps/yo-chat"),
      childEnv,
    );
  }

  console.error(
    `Starting yo-chat: mode=${mode}, model=${provider}/${model}, tools=${mode === "cloudflare" ? "cloudflare" : (process.env["MCP_TOOL_RUNTIME"] ?? "local")}`,
  );
  if (mode === "cloudflare") {
    console.error(`Conversation host: ${childEnv.CHAT_HOST_PLACEMENT}`);
  }
  await runCommand(
    ["exec", "vite", "dev", "--port", "8000", ...args, "--strictPort", "--force"],
    resolve(repoRoot, "apps/yo-chat"),
    childEnv,
  );
}

launch().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
