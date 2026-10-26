import { defineConfig, type UserConfig } from "vite";
import { readStoredModelSelection } from "@sweatpants/model-provider-pi-ai";
import baseConfig from "./vite.config";

const selectedModel = readStoredModelSelection();

/**
 * Vitest config for the outside-in HTTP test tier (design R11/C6).
 *
 * Runs ONLY `src/outside-in/**` under a Node environment (worker_threads +
 * effection + real server), separate from the hermetic default unit run.
 *
 *   pnpm test:outside-in          # full integration: real model + Tier A + Tier B
 *   pnpm test:outside-in:tier-a   # faster integration: real model + Tier A
 *   pnpm test:outside-in:hermetic # no-network worker-boundary guard only
 *
 * Live flows run when `RUN_LIVE=1`; missing selected-provider auth fails fast
 * in test setup instead of silently skipping requested integration coverage.
 * Tier B runs when `OUTSIDE_IN_TIER_B=1`.
 *
 * NOTE: `test` is replaced (not merged) so the base run's outside-in exclude
 * glob does not leak in and hide these tests.
 */
export default defineConfig((env) => {
  const base = typeof baseConfig === "function" ? baseConfig(env) : baseConfig;
  const config: UserConfig = {
    ...base,
    test: {
      environment: "node",
      env: {
        DEFAULT_CHAT_MODEL_PROVIDER:
          process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? selectedModel?.provider ?? "github-copilot",
        DEFAULT_CHAT_MODEL_ID:
          process.env["DEFAULT_CHAT_MODEL_ID"] ?? selectedModel?.id ?? "claude-sonnet-4.6",
      },
      include: ["src/outside-in/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
      globalSetup: ["./src/outside-in/global-setup.ts"],
      // Fork pool: tool workers are real worker threads; the worker config also
      // passes explicit dev/tsx execArgv for workspace source imports.
      pool: "forks",
      // Bound live-flow fan-out so the complete matrix remains below the
      // 120-second suite budget while avoiding unbounded provider/runtime load.
      fileParallelism: true,
      maxWorkers: Number.parseInt(process.env["OUTSIDE_IN_MAX_WORKERS"] ?? "2", 10),
      // One failing flow must stop the matrix immediately; otherwise Tier A/B
      // permutations can serialize the same failure for several minutes.
      bail: 1,
      testTimeout: Number.parseInt(process.env["OUTSIDE_IN_TEST_TIMEOUT_MS"] ?? "85000", 10),
      hookTimeout: Number.parseInt(process.env["OUTSIDE_IN_HOOK_TIMEOUT_MS"] ?? "60000", 10),
    },
  };
  return config;
});
