export const CODING_HARNESS_ID = "yo-studio.coding-harness";
export const CODING_HARNESS_VERSION = "1.0.0";
export const CODING_HARNESS_ITERATIONS = 24;

/** Browser-safe deployment projection; it never imports the durable program. */
export const studioView = Object.freeze({
  name: "yo-studio",
  program: Object.freeze({
    id: CODING_HARNESS_ID,
    version: CODING_HARNESS_VERSION,
    modelLoop: "journal-native chat root",
    maxIterations: CODING_HARNESS_ITERATIONS,
  }),
  modelProvider: Object.freeze({ adapter: "pi-ai", model: "github-copilot/gpt-5.5" }),
  modelSampling: Object.freeze({ ownership: "host" as const }),
  capabilityNames: Object.freeze([
    "workspace_inspect",
    "workspace_read",
    "workspace_list",
    "workspace_write",
    "workspace_test",
  ]),
  workspace: Object.freeze({
    scripts: Object.freeze({ test: "pnpm test", typecheck: "pnpm check", lint: "pnpm lint" }),
    policy: Object.freeze({ network: "trusted-development" as const }),
  }),
  sandbox: Object.freeze({
    image: Object.freeze({ node: "24", architecture: "arm64" as const }),
    capabilities: Object.freeze({ workspacePersistence: "sandbox_lease" as const }),
  }),
  projections: Object.freeze(["react-chat", "headless-http", "mcp"]),
});
