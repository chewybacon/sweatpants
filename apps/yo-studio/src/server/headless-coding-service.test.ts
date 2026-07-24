import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLoopbackWorkspaceConnector,
  createWorkspaceService,
  type WorkspaceFence,
} from "@sweatpants/workspace-runtime";

import { createHeadlessCodingService } from "./headless-coding-service.ts";

const roots: string[] = [];
const fence: WorkspaceFence = {
  taskId: "coding-task",
  sandboxGeneration: "local-generation",
  activationEpoch: 1,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("headless durable coding vertical", () => {
  it("drives the journal-native chat root through workspace write and test effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "yo-studio-headless-"));
    roots.push(root);
    const workspace = createWorkspaceService({
      root,
      workspaceId: "coding-workspace",
      scripts: { test: "test \"$(cat demo.txt)\" = 'hello from durable yo-studio'" },
    });
    workspace.bind(fence);
    const service = createHeadlessCodingService({
      connector: createLoopbackWorkspaceConnector(workspace),
      fence,
    });

    const result = await run(function* () {
      return yield* service.start({
        task: "Create demo.txt and validate it",
        workspaceRevision: workspace.currentWorkspaceVersion(),
      });
    });

    expect(result).toMatchObject({ state: "completed" });
    expect(JSON.stringify(result.value)).toContain("declared test script passed");
    await expect(readFile(join(root, "demo.txt"), "utf8")).resolves.toBe(
      "hello from durable yo-studio\n",
    );
    const descriptors = result.trace.tasks.flatMap((task) =>
      task.operations.flatMap((operation) =>
        typeof operation.descriptor === "object" &&
        operation.descriptor !== null &&
        !Array.isArray(operation.descriptor)
          ? [operation.descriptor]
          : [],
      ),
    );
    expect(descriptors).toContainEqual(expect.objectContaining({ name: "model.sample" }));
    expect(descriptors).toContainEqual(
      expect.objectContaining({ kind: "record", label: "workspace-write" }),
    );
    expect(descriptors).toContainEqual(
      expect.objectContaining({ kind: "record", label: "workspace-run-script" }),
    );
  });
});
