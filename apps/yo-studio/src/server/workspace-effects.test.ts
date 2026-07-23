import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLoopbackWorkspaceConnector,
  createWorkspaceService,
  type WorkspaceFence,
} from "@sweatpants/workspace-runtime";

import { createWorkspaceEffectRegistrations } from "./workspace-effects.ts";

const roots: string[] = [];
const fence: WorkspaceFence = {
  taskId: "task",
  sandboxGeneration: "generation",
  activationEpoch: 1,
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yo-studio-effects-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.txt"), "before", "utf8");
  const service = createWorkspaceService({
    root,
    workspaceId: "workspace",
    scripts: { test: 'test "$(cat src/value.txt)" = after' },
  });
  service.bind(fence);
  const connector = createLoopbackWorkspaceConnector(service);
  const registrations = createWorkspaceEffectRegistrations({
    *resolve() {
      return { connector, fence };
    },
  });
  const byName = new Map(
    registrations.map((registration) => [registration.definition.name, registration]),
  );
  const context = {
    sessionId: "session",
    taskId: "task",
    pullId: "pull-1",
    attemptId: "attempt-1",
    cancellation: new AbortController().signal,
    resolver: { audience: "workspace" },
  };
  return { service, byName, context };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("yo-studio workspace effect adapter", () => {
  it("executes read, write, and named validation through the finite connector", async () => {
    const { service, byName, context } = await fixture();
    const initial = service.currentWorkspaceVersion();
    const read = byName.get("yo-studio.workspace.read")!;
    const write = byName.get("yo-studio.workspace.write")!;
    const test = byName.get("yo-studio.workspace.run-script")!;

    await expect(
      run(function* () {
        return yield* read.handler({ path: "src/value.txt", workspaceVersion: initial }, context);
      }),
    ).resolves.toMatchObject({ status: "ok", value: { content: "before" } });

    const written = await run(function* () {
      return yield* write.handler(
        { path: "src/value.txt", content: "after", expectedWorkspaceVersion: initial },
        { ...context, pullId: "pull-2" },
      );
    });
    expect(written).toMatchObject({ status: "ok", value: { type: "write-result" } });
    if (written.status !== "ok" || typeof written.value !== "object" || written.value === null) {
      throw new Error("write did not return a workspace result");
    }
    const workspaceVersion = (written.value as { workspaceVersion: string }).workspaceVersion;

    await expect(
      run(function* () {
        return yield* test.handler(
          { script: "test", workspaceVersion },
          { ...context, pullId: "pull-3" },
        );
      }),
    ).resolves.toMatchObject({ status: "ok", value: { exitCode: 0 } });
  });
});
