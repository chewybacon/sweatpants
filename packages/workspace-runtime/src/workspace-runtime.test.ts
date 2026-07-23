import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkspaceService,
  type WorkspaceFence,
  type WorkspaceRequest,
  type WorkspaceService,
} from "./index.ts";

const roots: string[] = [];
const fence: WorkspaceFence = {
  taskId: "task-1",
  sandboxGeneration: "generation-1",
  activationEpoch: 1,
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sweatpants-workspace-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.txt"), "before", "utf8");
  const service = createWorkspaceService({
    root,
    workspaceId: "workspace-1",
    scripts: { test: 'test "$(cat src/value.txt)" = after' },
  });
  service.bind(fence);
  return { root, service };
}

function execute(service: WorkspaceService, request: WorkspaceRequest) {
  return run(function* () {
    return yield* service.execute(request);
  });
}

function handle(service: WorkspaceService, request: Request) {
  return run(function* () {
    return yield* service.handle(request);
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace runtime", () => {
  it("reads, versions a write, deduplicates it, and runs a named script", async () => {
    const { root, service } = await fixture();
    const initial = service.currentWorkspaceVersion();
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "read",
        fence,
        operationId: "read-1",
        workspaceVersion: initial,
        path: "src/value.txt",
      }),
    ).resolves.toMatchObject({ type: "read-result", content: "before", workspaceVersion: initial });

    const write = {
      protocolVersion: 1 as const,
      type: "write" as const,
      fence,
      operationId: "write-1",
      workspaceVersion: initial,
      path: "src/value.txt",
      content: "after",
    };
    const written = await execute(service, write);
    expect(written.type).toBe("write-result");
    expect(written.workspaceVersion).not.toBe(initial);
    await expect(readFile(join(root, "src", "value.txt"), "utf8")).resolves.toBe("after");

    // Retried mutation returns the committed outcome even though the live frontier advanced.
    await expect(execute(service, write)).resolves.toEqual(written);
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "run-script",
        fence,
        operationId: "test-1",
        workspaceVersion: written.workspaceVersion,
        script: "test",
      }),
    ).resolves.toMatchObject({ type: "script-result", exitCode: 0 });
  });

  it("rejects stale fences, stale workspace versions, traversal, and undeclared scripts", async () => {
    const { service } = await fixture();
    const version = service.currentWorkspaceVersion();
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "read",
        fence: { ...fence, activationEpoch: 0 },
        operationId: "read-stale",
        workspaceVersion: version,
        path: "src/value.txt",
      }),
    ).rejects.toMatchObject({ code: "invalid_mcp_request" });
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "read",
        fence: { ...fence, activationEpoch: 2 },
        operationId: "read-stale",
        workspaceVersion: version,
        path: "src/value.txt",
      }),
    ).rejects.toMatchObject({ code: "sandbox_generation_stale" });
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "read",
        fence,
        operationId: "read-version",
        workspaceVersion: "0".repeat(64),
        path: "src/value.txt",
      }),
    ).rejects.toMatchObject({ code: "workspace_version_conflict" });
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "read",
        fence,
        operationId: "read-traversal",
        workspaceVersion: version,
        path: "../secret",
      }),
    ).rejects.toMatchObject({ code: "network_policy_denied" });
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "run-script",
        fence,
        operationId: "unknown-script",
        workspaceVersion: version,
        script: "deploy",
      }),
    ).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  it("serves the same closed protocol over finite HTTP", async () => {
    const { service } = await fixture();
    const response = await handle(
      service,
      new Request("http://workspace/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          type: "list",
          fence,
          operationId: "list-1",
          workspaceVersion: service.currentWorkspaceVersion(),
          path: "src",
        }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "list-result",
      entries: ["value.txt"],
    });
  });
});
