import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkspaceService,
  parseWorkspaceResponse,
  type WorkspaceFence,
  type WorkspaceRequest,
  type WorkspaceService,
} from "../index.ts";

const roots: string[] = [];
const fence: WorkspaceFence = {
  taskId: "task-1",
  sandboxGeneration: "generation-1",
  activationEpoch: 1,
};

async function fixture(maximumCommandMs = 1_000) {
  const root = await mkdtemp(join(tmpdir(), "sweatpants-workspace-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.txt"), "before", "utf8");
  const service = createWorkspaceService({
    root,
    workspaceId: "workspace-1",
    scripts: {
      test: 'test "$(cat src/value.txt)" = after',
      mutate: 'printf "script-change" > src/value.txt',
      background: "sh -c 'trap \"\" TERM; sleep 0.2; printf escaped > src/background.txt' & wait",
    },
    maximumCommandMs,
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
  it("exposes named direct operations with revision-free observations", async () => {
    const { service } = await fixture();
    const execution = { fence, operationId: "direct-inspect" };
    const inspected = await run(function* () {
      return yield* service.operations.inspect(execution);
    });
    const read = await run(function* () {
      return yield* service.operations.readFile(
        { path: "src/value.txt", startLine: 1, endLine: 1 },
        { fence, operationId: "direct-read" },
      );
    });
    const listed = await run(function* () {
      return yield* service.operations.list({ path: "src" }, { fence, operationId: "direct-list" });
    });
    expect(read).toMatchObject({
      contents: "before",
      startLine: 1,
      endLine: 1,
      workspaceRevision: inspected.workspaceRevision,
    });
    expect(listed).toMatchObject({
      entries: ["value.txt"],
      workspaceRevision: inspected.workspaceRevision,
    });
  });
  it("reads, versions a write, deduplicates it, and runs a named script", async () => {
    const { root, service } = await fixture();
    const initial = service.currentWorkspaceVersion();
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "read",
        fence,
        operationId: "read-1",
        path: "src/value.txt",
      }),
    ).resolves.toMatchObject({ type: "read-result", content: "before", workspaceVersion: initial });

    const write = {
      protocolVersion: 1 as const,
      type: "write" as const,
      fence,
      operationId: "write-1",
      expectedWorkspaceRevision: initial,
      path: "src/value.txt",
      contents: "after",
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
        expectedWorkspaceRevision: written.workspaceVersion,
        script: "test",
      }),
    ).resolves.toMatchObject({ type: "script-result", exitCode: 0 });
  });

  it("advances the mutation frontier after an opaque script", async () => {
    const { root, service } = await fixture();
    const initial = service.currentWorkspaceVersion();
    const request = {
      protocolVersion: 1 as const,
      type: "run-script" as const,
      fence,
      operationId: "mutate-1",
      expectedWorkspaceRevision: initial,
      script: "mutate",
    };

    const result = await execute(service, request);
    expect(result).toMatchObject({ type: "script-result", exitCode: 0 });
    expect(result.workspaceVersion).not.toBe(initial);
    await expect(readFile(join(root, "src", "value.txt"), "utf8")).resolves.toBe("script-change");
    await expect(execute(service, request)).resolves.toEqual(result);

    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "write",
        fence,
        operationId: "stale-after-script",
        expectedWorkspaceRevision: initial,
        path: "src/value.txt",
        contents: "stale-write",
      }),
    ).rejects.toMatchObject({ code: "workspace_conflict" });
  });

  it("kills the complete script process group on timeout", async () => {
    const { root, service } = await fixture(50);
    const result = await execute(service, {
      protocolVersion: 1,
      type: "run-script",
      fence,
      operationId: "background-1",
      expectedWorkspaceRevision: service.currentWorkspaceVersion(),
      script: "background",
    });
    expect(result).toMatchObject({ type: "script-result", exitCode: 1 });

    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    await expect(readFile(join(root, "src", "background.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps scripts immutable and fences out an older activation epoch", async () => {
    const { service } = await fixture();
    expect(() => service.bind(fence, { test: "false" })).toThrow(/cannot change/);

    const resumedFence = { ...fence, activationEpoch: 2 };
    service.bind(resumedFence);
    expect(service.currentFence()).toEqual(resumedFence);
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "inspect",
        fence,
        operationId: "inspect-old-activation",
      }),
    ).rejects.toMatchObject({ code: "sandbox_generation_stale" });
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "inspect",
        fence: resumedFence,
        operationId: "inspect-new-activation",
      }),
    ).resolves.toMatchObject({ type: "inspect-result" });
  });

  it("rejects stale fences, stale mutation revisions, traversal, and undeclared scripts", async () => {
    const { service } = await fixture();
    const version = service.currentWorkspaceVersion();
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "read",
        fence: { ...fence, activationEpoch: 0 },
        operationId: "read-stale",
        path: "src/value.txt",
      }),
    ).rejects.toMatchObject({ code: "invalid_mcp_request" });
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "read",
        fence: { ...fence, activationEpoch: 2 },
        operationId: "read-stale",
        path: "src/value.txt",
      }),
    ).rejects.toMatchObject({ code: "sandbox_generation_stale" });
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "write",
        fence,
        operationId: "write-version",
        expectedWorkspaceRevision: "0".repeat(64),
        path: "src/value.txt",
        contents: "stale",
      }),
    ).rejects.toMatchObject({
      code: "workspace_conflict",
      details: { expected: "0".repeat(64), current: version },
    });
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "read",
        fence,
        operationId: "read-traversal",
        path: "../secret",
      }),
    ).rejects.toMatchObject({ code: "network_policy_denied" });
    await expect(
      execute(service, {
        protocolVersion: 1,
        type: "run-script",
        fence,
        operationId: "unknown-script",
        expectedWorkspaceRevision: version,
        script: "deploy",
      }),
    ).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  it("rejects oversized listing responses before they reach a journal consumer", () => {
    expect(() =>
      parseWorkspaceResponse({
        type: "list-result",
        path: ".",
        entries: Array.from({ length: 10_001 }, (_, index) => `entry-${index}`),
        workspaceVersion: "a".repeat(64),
      }),
    ).toThrow(/bounded string list/);
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
