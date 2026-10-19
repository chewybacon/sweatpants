import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { call, main, suspend, type Operation } from "effection";

import {
  createWorkspaceService,
  parseWorkspaceRequest,
  useNodeHttpServer,
  type WorkspaceFence,
} from "@sweatpants/workspace-runtime";

const workspace = process.env["SWEATPANTS_WORKSPACE"] ?? "/workspace";
const lifecyclePath = resolve(workspace, ".sweatpants", "lifecycle.jsonl");
const statePath = resolve(workspace, ".sweatpants", "sandbox.json");
const hookPrefix = "/aws/lambda-microvms/runtime/v1";

interface SandboxState {
  sandboxId: string;
  microvmId?: string;
  taskId?: string;
  phase: "snapshot" | "running" | "suspended" | "terminating";
  resumeCount: number;
  requestCount: number;
  runAt?: string;
  resumedAt?: string;
}

await main(function* () {
  yield* call(() => mkdir(resolve(workspace, ".sweatpants"), { recursive: true }));
  let state: SandboxState = {
    sandboxId: "snapshot-placeholder",
    phase: "snapshot",
    resumeCount: 0,
    requestCount: 0,
  };
  const workspaceService = createWorkspaceService({
    root: workspace,
    workspaceId: process.env["SWEATPANTS_WORKSPACE_ID"] ?? "task-workspace",
    scripts: parseScripts(process.env["SWEATPANTS_WORKSPACE_SCRIPTS"]),
  });

  yield* useNodeHttpServer({
    port: 8080,
    *handle(request, response) {
      try {
        if (state.phase !== "running") {
          sendJson(response, 503, {
            error: { code: "sandbox_unavailable", message: state.phase },
          });
          return;
        }
        state.requestCount += 1;
        yield* persistState(state);
        const url = new URL(request.url ?? "/", "http://sandbox");
        if (request.method === "GET" && url.pathname === "/health") {
          sendJson(response, 200, {
            ready: workspaceService.currentFence() !== undefined,
            state,
            fence: workspaceService.currentFence(),
            workspaceVersion: workspaceService.currentWorkspaceVersion(),
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/activation/bind") {
          const payload = yield* readJson(request, 16 * 1024);
          workspaceService.bind(parseFence(payload), parseScriptObject(payload["scripts"]));
          sendJson(response, 200, {
            bound: true,
            fence: workspaceService.currentFence(),
            workspaceVersion: workspaceService.currentWorkspaceVersion(),
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/workspace") {
          const payload = yield* readJson(request, 2 * 1024 * 1024);
          sendJson(response, 200, yield* workspaceService.execute(parseWorkspaceRequest(payload)));
          return;
        }
        sendJson(response, 404, { error: { code: "invalid_request", message: "not found" } });
      } catch (error) {
        const code = errorCode(error);
        sendJson(response, errorStatus(code), {
          error: {
            code,
            message: bounded(error),
          },
        });
      }
    },
  });

  yield* useNodeHttpServer({
    port: 9000,
    *handle(request, response) {
      try {
        const path = new URL(request.url ?? "/", "http://hooks").pathname;
        if (request.method !== "POST" || !path.startsWith(hookPrefix)) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        const hook = path.slice(hookPrefix.length + 1);
        if (hook === "ready") {
          sendJson(response, 200, { ready: true });
          return;
        }
        if (hook === "validate") {
          sendJson(response, 200, { valid: true });
          return;
        }
        if (hook === "run") {
          const payload = yield* readJson(request, 16 * 1024);
          state = {
            sandboxId: randomUUID(),
            /* CONDITIONAL-SPREAD: Omit absent microvmId from sandbox control responses; explicit undefined is not a portable JSON value. */
            ...(typeof payload["microvmId"] === "string"
              ? { microvmId: payload["microvmId"] }
              : {}),
            /* CONDITIONAL-SPREAD: Omit absent taskId from sandbox control responses; explicit undefined is not a portable JSON value. */
            ...(typeof payload["taskId"] === "string" ? { taskId: payload["taskId"] } : {}),
            phase: "running",
            resumeCount: 0,
            requestCount: 0,
            runAt: new Date().toISOString(),
          };
          if (state.taskId) {
            workspaceService.bind(
              {
                taskId: state.taskId,
                sandboxGeneration: state.microvmId ?? state.sandboxId,
                activationEpoch:
                  typeof payload["activationEpoch"] === "number" ? payload["activationEpoch"] : 1,
              },
              parseScriptObject(payload["scripts"]),
            );
          }
          yield* appendLifecycle("run");
          yield* persistState(state);
          sendJson(response, 200, {
            running: true,
            workspaceVersion: workspaceService.currentWorkspaceVersion(),
          });
          return;
        }
        if (hook === "resume") {
          state.phase = "running";
          state.resumeCount += 1;
          state.resumedAt = new Date().toISOString();
          yield* appendLifecycle("resume");
          yield* persistState(state);
          sendJson(response, 200, { resumed: true });
          return;
        }
        if (hook === "suspend") {
          state.phase = "suspended";
          yield* appendLifecycle("suspend");
          yield* persistState(state);
          sendJson(response, 200, { suspended: true });
          return;
        }
        if (hook === "terminate") {
          state.phase = "terminating";
          yield* appendLifecycle("terminate");
          yield* persistState(state);
          sendJson(response, 200, { terminating: true });
          return;
        }
        sendJson(response, 404, { error: "unknown_hook" });
      } catch (error) {
        sendJson(response, 500, { error: bounded(error) });
      }
    },
  });

  console.log("workspace service listening on 8080");
  console.log("sandbox lifecycle hooks listening on 9000");
  yield* suspend();
});

function* readJson(request: IncomingMessage, maximum: number): Operation<Record<string, unknown>> {
  const chunks = yield* call(async () => {
    const output: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maximum) {
        throw new Error("request body is too large");
      }
      output.push(buffer);
    }
    return output;
  });
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function parseFence(value: Record<string, unknown>): WorkspaceFence {
  const taskId = value["taskId"];
  const sandboxGeneration = value["sandboxGeneration"];
  const activationEpoch = value["activationEpoch"];
  if (
    typeof taskId !== "string" ||
    typeof sandboxGeneration !== "string" ||
    !Number.isSafeInteger(activationEpoch) ||
    (activationEpoch as number) < 1
  ) {
    throw new Error("invalid activation fence");
  }
  return { taskId, sandboxGeneration, activationEpoch: activationEpoch as number };
}

function parseScriptObject(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace scripts must be an object");
  }
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(value)) {
    if (typeof command !== "string") {
      throw new Error(`workspace script ${name} must be a string`);
    }
    scripts[name] = command;
  }
  return scripts;
}

function parseScripts(value: string | undefined): Readonly<Record<string, string>> {
  if (!value) {
    return {};
  }
  return parseScriptObject(JSON.parse(value) as unknown) ?? {};
}

function* persistState(state: SandboxState): Operation<void> {
  yield* call(() => writeFile(statePath, JSON.stringify(state, null, 2), "utf8"));
}

function* appendLifecycle(event: string): Operation<void> {
  yield* call(() =>
    appendFile(
      lifecyclePath,
      `${JSON.stringify({ event, at: new Date().toISOString() })}\n`,
      "utf8",
    ),
  );
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function errorStatus(code: string): number {
  switch (code) {
    case "sandbox_generation_stale":
    case "workspace_version_conflict":
    case "nondeterminism_detected":
      return 409;
    case "payload_too_large":
      return 413;
    case "sandbox_unavailable":
      return 503;
    case "internal_error":
      return 500;
    default:
      return 400;
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "internal_error";
}

function bounded(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
