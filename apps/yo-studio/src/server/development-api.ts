import { mkdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { call, type Operation } from "effection";

import {
  createLoopbackWorkspaceConnector,
  createWorkspaceService,
  type WorkspaceConnector,
  type WorkspaceFence,
  type WorkspaceOperations,
  type WorkspaceService,
} from "@sweatpants/workspace-runtime";

import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { createHeadlessCodingService } from "./headless-coding-service.ts";

export interface StudioDevelopmentRuntime {
  readonly workspace: WorkspaceService;
  readonly connector: WorkspaceConnector;
  readonly operations: WorkspaceOperations;
  readonly fence: WorkspaceFence;
}

export interface StudioDevelopmentApi {
  handle(request: IncomingMessage, response: ServerResponse, next: () => void): Operation<void>;
}

export function* createStudioDevelopmentRuntime(root: string): Operation<StudioDevelopmentRuntime> {
  const workspaceRoot = resolve(root, ".artifacts", "yo-studio", "workspace");
  yield* call(() => mkdir(workspaceRoot, { recursive: true }));
  const fence: WorkspaceFence = {
    taskId: "yo-studio-development-task",
    sandboxGeneration: "local-development-generation",
    activationEpoch: 1,
  };
  const workspace = createWorkspaceService({
    root: workspaceRoot,
    workspaceId: "yo-studio-development-workspace",
    scripts: {
      test: "test \"$(cat demo.txt)\" = 'hello from durable yo-studio'",
      typecheck: "true",
      lint: "true",
    },
  });
  workspace.bind(fence);
  return {
    workspace,
    operations: workspace.operations,
    connector: createLoopbackWorkspaceConnector(workspace),
    fence,
  };
}

export function createStudioDevelopmentApi(
  runtime: StudioDevelopmentRuntime,
): StudioDevelopmentApi {
  const { workspace, fence } = runtime;
  const coding = createHeadlessCodingService({
    operations: workspace.operations,
    fence,
    executionStore: createMemoryExecutionStore(),
  });
  return {
    *handle(request, response, next) {
      const url = new URL(request.url ?? "/", "http://yo-studio");
      if (request.method === "GET" && url.pathname === "/api/tasks/status") {
        send(response, 200, {
          ready: true,
          workspaceRevision: workspace.currentWorkspaceVersion(),
          placement: "local finite-HTTP semantic equivalent",
        });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/api/tasks") {
        next();
        return;
      }
      try {
        const body = yield* readBody(request);
        const task = body["task"];
        if (typeof task !== "string" || task.length < 1 || task.length > 8_192) {
          throw new Error("task must be bounded text");
        }
        const result = yield* coding.start({
          task,
          workspaceRevision: workspace.currentWorkspaceVersion(),
        });
        const operations = result.trace.tasks.flatMap((taskTrace) =>
          taskTrace.operations.flatMap((operation) => {
            const descriptor = operation.descriptor;
            if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
              return [];
            }
            if (descriptor["kind"] === "effect" && typeof descriptor["name"] === "string") {
              return [descriptor["name"]];
            }
            if (
              descriptor["kind"] === "invoke" &&
              descriptor["child"] &&
              typeof descriptor["child"] === "object"
            ) {
              const child = descriptor["child"] as Record<string, unknown>;
              return typeof child["id"] === "string" ? [`invoke:${child["id"]}`] : [];
            }
            return [];
          }),
        );
        send(response, 200, {
          sessionId: result.sessionId,
          taskId: result.taskId,
          state: result.state,
          value: result.value,
          workspaceRevision: workspace.currentWorkspaceVersion(),
          operations,
        });
      } catch (error) {
        send(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

function* readBody(request: IncomingMessage): Operation<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (const chunk of yield* readRequestChunks(request)) {
    bytes += chunk.byteLength;
    if (bytes > 16 * 1024) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function* readRequestChunks(request: IncomingMessage): Operation<Buffer[]> {
  return yield* call(async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks;
  });
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}
