import { spawnSync } from "node:child_process";
import {
  defaultModelForProvider,
  isYoChatAuthProvider,
  readStoredModelSelection,
} from "../packages/model-provider-pi-ai/src/auth.ts";

let provider = process.env["DEFAULT_CHAT_MODEL_PROVIDER"];
let model = process.env["DEFAULT_CHAT_MODEL_ID"];
const playwrightArgs: string[] = [];
const args = process.argv.slice(2);

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!;
  if (argument === "--provider") {
    provider = args[++index];
    continue;
  }
  if (argument.startsWith("--provider=")) {
    provider = argument.slice("--provider=".length);
    continue;
  }
  if (argument === "--model") {
    model = args[++index];
    continue;
  }
  if (argument.startsWith("--model=")) {
    model = argument.slice("--model=".length);
    continue;
  }
  playwrightArgs.push(argument);
}

const selected = readStoredModelSelection();
const effectiveProvider = provider ?? selected?.provider ?? "github-copilot";
if (!isYoChatAuthProvider(effectiveProvider)) {
  console.error(
    `--provider must be github-copilot, openai-codex, or opencode; got ${effectiveProvider}`,
  );
  process.exit(1);
}
const effectiveModel =
  model ??
  (selected?.provider === effectiveProvider ? selected.id : undefined) ??
  defaultModelForProvider(effectiveProvider);

console.log(`Running full yo-chat E2E with ${effectiveProvider}/${effectiveModel}`);
const result = spawnSync(
  "pnpm",
  ["-C", "apps/yo-chat", "exec", "playwright", "test", ...playwrightArgs],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_FULL: "1",
      DEFAULT_CHAT_MODEL_PROVIDER: effectiveProvider,
      DEFAULT_CHAT_MODEL_ID: effectiveModel,
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
