import {
  defineDeployment,
  defineModelProvider,
  defineWorkspace,
  developmentJournal,
  headlessHttp,
  hostModelSampling,
  lambdaMicrovm,
  reactChat,
  streamableMcp,
  workspaceSource,
} from "@sweatpants/framework/deployment";

import { codingCapabilities } from "./capabilities/workspace.ts";
import { codingHarness } from "./programs/coding-harness.ts";

export const codingModelProvider = defineModelProvider({
  name: "coding",
  adapter: "pi-ai",
  model: {
    provider: process.env["YO_STUDIO_MODEL_PROVIDER"] ?? "github-copilot",
    id: process.env["YO_STUDIO_MODEL_ID"] ?? "gpt-5.5",
  },
});

export const codingModelSampling = hostModelSampling(codingModelProvider);

export const productWorkspace = defineWorkspace({
  source: workspaceSource.local("."),
  root: ".",
  packageManager: "pnpm",
  setup: ["pnpm install --frozen-lockfile"],
  scripts: {
    test: "pnpm test",
    typecheck: "pnpm check",
    lint: "pnpm lint",
  },
  policy: {
    network: "trusted-development",
    writes: "approval",
    externalEffects: "trusted-development",
  },
  persistence: "sandbox_lease",
});

export const codingSandbox = lambdaMicrovm({
  image: {
    name: "sweatpants-durable-sandbox",
    version: "7.0",
    node: "24",
    architecture: "arm64",
  },
  lifecycle: {
    warmIdleSeconds: 300,
    suspendedLifetimeSeconds: 28_800,
    autoResume: true,
  },
});

export const studioDeployment = defineDeployment({
  name: "yo-studio",
  mode: "development",
  authority: developmentJournal(),
  modelProvider: codingModelProvider,
  modelSampling: codingModelSampling,
  programs: { code: codingHarness },
  capabilities: codingCapabilities,
  workspace: productWorkspace,
  sandbox: codingSandbox,
  projections: [reactChat(), headlessHttp(), streamableMcp()],
});
