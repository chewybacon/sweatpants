import { resolve } from "node:path";
import { readMode } from "./dev-options.ts";
import { prepareApp, repoRoot, runCommand } from "./dev-app.ts";
import {
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
    await runCommand([
      "--filter",
      "@sweatpants/model-provider-pi-ai",
      "dev:auth:refresh",
      "--provider",
      provider,
    ]);
  }

  if (mode === "cloudflare" || mode === "d1-local") {
    throw new Error(
      "yo-chat remote deployment modes have been retired; use pnpm --filter yo-chat dev",
    );
  }
  console.error(`Starting yo-chat: mode=${mode}, model=${provider}/${model}, tools=local`);
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
