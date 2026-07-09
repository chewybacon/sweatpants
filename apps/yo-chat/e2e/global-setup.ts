import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export default async function globalSetup(): Promise<void> {
  const provider = process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "github-copilot";

  // Default Playwright runs are deterministic smoke only and do not require a
  // live model. Full live-model E2E is opt-in via E2E_FULL=1; fail fast on the
  // actual workspace auth check instead of waiting for downstream UI timeouts.
  if (provider !== "github-copilot") {
    return;
  }

  const repoRoot = resolve(process.cwd(), "../..");

  try {
    execFileSync("pnpm", ["--dir", repoRoot, "copilot:auth:status"], {
      stdio: "inherit",
      env: process.env,
    });
  } catch (error) {
    throw new Error(
      "[playwright-e2e] GitHub Copilot auth precondition failed. Run `pnpm copilot:auth:refresh` then `pnpm copilot:auth:sync` and retry.",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}
