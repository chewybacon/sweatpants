import { afterEach, describe, expect, it, vi } from "vitest";
import {
  selectVerification,
  verificationEnvironment,
  type WorkspaceProject,
} from "../verification.ts";

const projects: WorkspaceProject[] = [
  { name: "port", directory: "packages/port", dependencies: [], scripts: {}, testTypes: true },
  {
    name: "adapter",
    directory: "packages/adapter",
    dependencies: ["port"],
    scripts: {},
    testTypes: true,
  },
  { name: "app", directory: "apps/chat", dependencies: ["adapter"], scripts: {}, testTypes: false },
  {
    name: "unrelated",
    directory: "packages/unrelated",
    dependencies: [],
    scripts: {},
    testTypes: true,
  },
];

afterEach(() => vi.unstubAllEnvs());

describe("affected verification selection", () => {
  it("checks transitive consumers when a port changes, without selecting unrelated projects", () => {
    const result = selectVerification(projects, ["packages/port/src/new-untracked-file.ts"]);
    expect(result.projects.map((p) => p.name)).toEqual(["port", "adapter", "app"]);
    expect(result.broad).toBe(false);
  });

  it("falls back to the full gate for shared configuration and unmapped runtime inputs", () => {
    const result = selectVerification(projects, ["pnpm-lock.yaml", "experiments/recovery.mjs"]);
    expect(result.broad).toBe(true);
    expect(result.reasons).toHaveLength(2);
  });

  it("supports explicit roots by package name or directory and rejects typos", () => {
    expect(selectVerification(projects, [], ["apps/chat"]).projects.map((p) => p.name)).toEqual([
      "app",
    ]);
    expect(selectVerification(projects, [], ["adapter"]).projects.map((p) => p.name)).toEqual([
      "adapter",
      "app",
    ]);
    expect(() => selectVerification(projects, [], ["adpater"])).toThrow(
      "Unknown workspace project",
    );
  });

  it("does not confuse a sibling directory with a project's files", () => {
    expect(selectVerification(projects, ["packages/port-extra/index.ts"]).broad).toBe(true);
  });

  it("terminates when workspace dependencies contain a cycle", () => {
    const cyclic = projects.map((p) =>
      p.name === "port" ? { ...p, dependencies: ["adapter"] } : p,
    );
    expect(selectVerification(cyclic, [], ["port"]).projects.map((p) => p.name)).toEqual([
      "port",
      "adapter",
      "app",
    ]);
  });
});

it("overrides inherited pool limits with the current stage budget and prevents watch mode", () => {
  vi.stubEnv("VITEST_MAX_THREADS", "1");
  vi.stubEnv("VITEST_MAX_FORKS", "99");
  expect(verificationEnvironment(4)).toMatchObject({
    VITEST_MAX_THREADS: "4",
    VITEST_MAX_FORKS: "4",
    CI: "1",
  });
  expect(verificationEnvironment()).toMatchObject({
    VITEST_MAX_THREADS: "1",
    VITEST_MAX_FORKS: "1",
  });
});
