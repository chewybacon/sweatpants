import { describe, expect, it } from "vitest";
import { sha256 } from "@sweatpants/session-contract";

import {
  defineDeployment,
  defineModelProvider,
  defineWorkspace,
  developmentJournal,
  durableJournal,
  headlessHttp,
  hostModelSampling,
  lambdaMicrovm,
  reactChat,
  secretRef,
  streamableMcp,
  workspaceSource,
} from "./index.ts";

const provider = defineModelProvider({
  name: "coding",
  adapter: "pi-ai",
  model: { provider: "github-copilot", id: "gpt-5.5" },
});
const sampling = hostModelSampling(provider);

const capability = {
  manifest: { programId: "fixture.read", version: "1.0.0", digest: sha256("read") },
};
const program = {
  manifest: { programId: "fixture.program", version: "1.0.0", digest: sha256("program") },
  childPrograms: { read: capability },
};

function workspace(persistence: "sandbox_lease" | "checkpoint_restore" = "sandbox_lease") {
  return defineWorkspace({
    source: workspaceSource.git({ url: "https://example.com/repo.git", ref: "main" }),
    root: ".",
    packageManager: "pnpm",
    setup: ["pnpm install --frozen-lockfile"],
    scripts: { test: "pnpm test" },
    secrets: [secretRef("NPM_TOKEN")],
    policy: {
      network: "trusted-development",
      writes: "approval",
      externalEffects: "host-only",
    },
    persistence,
  });
}

function sandbox(checkpointRestore = false) {
  return lambdaMicrovm({
    image: {
      name: "sandbox",
      version: "3.0",
      node: "24",
      architecture: "arm64",
    },
    lifecycle: { warmIdleSeconds: 300, suspendedLifetimeSeconds: 28_800, autoResume: true },
    checkpointRestore,
  });
}

describe("deployment authoring", () => {
  it("builds stable digested workspace, provider, and deployment definitions", () => {
    const first = defineDeployment({
      name: "fixture",
      mode: "development",
      authority: developmentJournal(),
      modelProvider: provider,
      modelSampling: sampling,
      programs: { chat: program },
      capabilities: { read: capability },
      workspace: workspace(),
      sandbox: sandbox(),
      projections: [reactChat(), headlessHttp(), streamableMcp()],
    });
    const second = defineDeployment({
      name: "fixture",
      mode: "development",
      authority: developmentJournal(),
      modelProvider: provider,
      modelSampling: sampling,
      programs: { chat: program },
      capabilities: { read: capability },
      workspace: workspace(),
      sandbox: sandbox(),
      projections: [reactChat(), headlessHttp(), streamableMcp()],
    });
    expect(first.digest).toBe(second.digest);
    expect(first.workspace.digest).toBe(second.workspace.digest);
    expect(first.sandbox.digest).toBe(second.sandbox.digest);
    expect(first.projections[2]).toEqual({
      kind: "mcp",
      path: "/mcp",
      protocolVersion: "2025-11-25",
    });
  });

  it("fails closed for production memory authority and unsupported policy/capabilities", () => {
    expect(() =>
      defineDeployment({
        name: "bad",
        mode: "production",
        authority: developmentJournal(),
        modelProvider: provider,
        modelSampling: sampling,
        programs: { chat: program },
        capabilities: {},
        workspace: workspace(),
        sandbox: sandbox(),
        projections: [headlessHttp()],
      }),
    ).toThrow(/production deployment requires a durable journal port/);

    expect(() =>
      defineDeployment({
        name: "bad",
        mode: "production",
        authority: durableJournal("JOURNAL"),
        modelProvider: provider,
        modelSampling: sampling,
        programs: { chat: program },
        capabilities: {},
        workspace: workspace("checkpoint_restore"),
        sandbox: sandbox(false),
        projections: [headlessHttp()],
      }),
    ).toThrow(/workspace requires checkpoint restore/);

    const deniedWorkspace = defineWorkspace({
      source: workspaceSource.local("."),
      packageManager: "pnpm",
      policy: { network: "deny", writes: "approval", externalEffects: "host-only" },
      persistence: "sandbox_lease",
    });
    expect(() =>
      defineDeployment({
        name: "bad-network",
        mode: "production",
        authority: durableJournal("JOURNAL"),
        modelProvider: provider,
        modelSampling: sampling,
        programs: { chat: program },
        capabilities: {},
        workspace: deniedWorkspace,
        sandbox: sandbox(false),
        projections: [headlessHttp()],
      }),
    ).toThrow(/deny-network enforcement/);
  });

  it("rejects dangling child capabilities and projection path collisions", () => {
    expect(() =>
      defineDeployment({
        name: "dangling-capability",
        mode: "development",
        authority: developmentJournal(),
        modelProvider: provider,
        modelSampling: sampling,
        programs: { chat: program },
        capabilities: { orphan: capability },
        workspace: workspace(),
        sandbox: sandbox(),
        projections: [headlessHttp()],
      }),
    ).toThrow(/capability orphan is not referenced/);

    expect(() =>
      defineDeployment({
        name: "colliding-projections",
        mode: "development",
        authority: developmentJournal(),
        modelProvider: provider,
        modelSampling: sampling,
        programs: { chat: program },
        capabilities: {},
        workspace: workspace(),
        sandbox: sandbox(),
        projections: [reactChat("/shared"), headlessHttp("/shared")],
      }),
    ).toThrow(/projection paths must be unique/);
  });

  it("rejects invalid Lambda MicroVM lifecycle bounds", () => {
    expect(() =>
      lambdaMicrovm({
        image: {
          name: "sandbox",
          version: "3.0",
          node: "24",
          architecture: "arm64",
        },
        lifecycle: { warmIdleSeconds: 30, suspendedLifetimeSeconds: 28_800, autoResume: true },
      }),
    ).toThrow(/at least 60/);
  });

  it("keeps only secret references and rejects raw/unknown definition fields", () => {
    expect(workspace().secrets).toEqual([
      { format: "sweatpants.secret-ref.v1", name: "NPM_TOKEN" },
    ]);
    expect(() => secretRef("raw-token-value")).toThrow(/uppercase environment-style name/);
    expect(() =>
      defineWorkspace({
        source: workspaceSource.local("."),
        packageManager: "pnpm",
        scripts: {},
        policy: { network: "deny", writes: "deny", externalEffects: "host-only" },
        persistence: "none",
        unknown: true,
      } as never),
    ).toThrow(/unknown fields/);
  });
});
