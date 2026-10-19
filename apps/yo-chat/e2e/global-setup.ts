import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isYoChatAuthProvider, readStoredModelSelection } from "@sweatpants/model-provider-pi-ai";

export default async function globalSetup(): Promise<void> {
  // Default Playwright runs are deterministic smoke only. Full live-model E2E
  // checks and refreshes the selected provider before the web server starts.
  if (process.env["E2E_FULL"] !== "1") {
    return;
  }

  const selected = readStoredModelSelection();
  const provider =
    process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? selected?.provider ?? "github-copilot";
  if (!isYoChatAuthProvider(provider)) {
    return;
  }

  const repoRoot = resolve(process.cwd(), "../..");
  try {
    execFileSync("pnpm", ["--dir", repoRoot, "model:auth:refresh", "--provider", provider], {
      stdio: "inherit",
      env: process.env,
    });
  } catch (error) {
    throw new Error(
      `[playwright-e2e] ${provider} auth precondition failed. Run \`pnpm model:auth:login --provider ${provider}\` and retry.`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}
