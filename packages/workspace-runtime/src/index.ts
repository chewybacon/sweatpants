import { spawn as spawnProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  CrankError,
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  sha256,
  sortStrings,
  type Json,
  type SandboxActivationFence,
} from "@sweatpants/session-contract";
import { call, resource, useAbortSignal, useScope, type Operation, type Task } from "effection";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 10_000;
const MAX_COMMITTED_OPERATIONS = 128;

export type WorkspaceFence = SandboxActivationFence;

export interface WorkspaceServiceOptions {
  readonly root: string;
  readonly workspaceId: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly maximumCommandMs?: number;
}

interface RequestBase {
  readonly protocolVersion: 1;
  readonly fence: WorkspaceFence;
  readonly operationId: string;
  readonly workspaceVersion: string;
}

export type WorkspaceRequest =
  | {
      readonly protocolVersion: 1;
      readonly type: "inspect";
      readonly fence: WorkspaceFence;
      readonly operationId: string;
    }
  | (RequestBase & { readonly type: "read"; readonly path: string })
  | (RequestBase & { readonly type: "list"; readonly path: string })
  | (RequestBase & { readonly type: "write"; readonly path: string; readonly content: string })
  | (RequestBase & { readonly type: "run-script"; readonly script: string });

export type WorkspaceResponse =
  | {
      readonly type: "inspect-result";
      readonly workspaceVersion: string;
    }
  | {
      readonly type: "read-result";
      readonly path: string;
      readonly content: string;
      readonly workspaceVersion: string;
    }
  | {
      readonly type: "list-result";
      readonly path: string;
      readonly entries: readonly string[];
      readonly workspaceVersion: string;
    }
  | {
      readonly type: "write-result";
      readonly path: string;
      readonly bytes: number;
      readonly workspaceVersion: string;
    }
  | {
      readonly type: "script-result";
      readonly script: string;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly workspaceVersion: string;
    };

export interface WorkspaceConnector {
  request(request: WorkspaceRequest): Operation<WorkspaceResponse>;
}

export interface WorkspaceService {
  readonly initialWorkspaceVersion: string;
  bind(fence: WorkspaceFence, scripts?: Readonly<Record<string, string>>): void;
  currentFence(): WorkspaceFence | undefined;
  currentWorkspaceVersion(): string;
  execute(request: WorkspaceRequest): Operation<WorkspaceResponse>;
  handle(request: Request): Operation<Response>;
}

interface CommittedOperation {
  readonly requestDigest: string;
  readonly response: WorkspaceResponse;
}

/**
 * Creates the generic finite-request workspace service used by local tests and
 * the Lambda MicroVM image. It owns workspace bytes, never journal authority.
 */
export function createWorkspaceService(options: WorkspaceServiceOptions): WorkspaceService {
  const root = resolve(options.root);
  const initialWorkspaceVersion = sha256(
    `sweatpants.workspace.initial.v1\0${canonicalJson({ workspaceId: options.workspaceId })}`,
  );
  let workspaceVersion = initialWorkspaceVersion;
  let activeFence: WorkspaceFence | undefined;
  let scripts = normalizeScripts(options.scripts);
  const committed = new Map<string, CommittedOperation>();

  function bind(fence: WorkspaceFence, nextScripts?: Readonly<Record<string, string>>): void {
    validateFence(fence);
    const normalizedScripts = nextScripts ? normalizeScripts(nextScripts) : undefined;
    if (activeFence) {
      if (activeFence.taskId !== fence.taskId) {
        throw new CrankError(
          "sandbox_generation_stale",
          "sandbox is already bound to another task",
        );
      }
      if (fence.activationEpoch < activeFence.activationEpoch) {
        throw new CrankError("sandbox_generation_stale", "activation epoch moved backwards");
      }
      if (activeFence.sandboxGeneration !== fence.sandboxGeneration) {
        throw new CrankError("sandbox_generation_stale", "generation cannot change in one service");
      }
      if (normalizedScripts && canonicalJson(normalizedScripts) !== canonicalJson(scripts)) {
        throw new CrankError(
          "nondeterminism_detected",
          "declared scripts cannot change within a sandbox generation",
        );
      }
    }
    activeFence = structuredClone(fence);
    if (normalizedScripts) {
      scripts = normalizedScripts;
    }
  }

  function* execute(request: WorkspaceRequest): Operation<WorkspaceResponse> {
    validateRequest(request);
    assertFence(activeFence, request.fence);
    const requestDigest = canonicalSnapshot(assertJson(request)).sha;
    const previous = committed.get(request.operationId);
    if (previous) {
      if (previous.requestDigest !== requestDigest) {
        throw new CrankError("nondeterminism_detected", "operation ID was reused with new input");
      }
      return structuredClone(previous.response);
    }
    if (request.type === "inspect") {
      return { type: "inspect-result", workspaceVersion };
    }
    if (request.workspaceVersion !== workspaceVersion) {
      throw new CrankError("workspace_version_conflict", "workspace version is stale", {
        expected: workspaceVersion,
        received: request.workspaceVersion,
      });
    }

    switch (request.type) {
      case "read": {
        const path = yield* workspacePath(request.path, false);
        const stat = yield* call(() => lstat(path));
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
          throw new CrankError("payload_too_large", "workspace file is not a bounded regular file");
        }
        return {
          type: "read-result",
          path: relative(yield* call(() => realpath(root)), path),
          content: yield* call(() => readFile(path, "utf8")),
          workspaceVersion,
        };
      }
      case "list": {
        const path = yield* workspacePath(request.path, false);
        const entries = sortStrings(yield* call(() => readdir(path)));
        if (
          entries.length > MAX_LIST_ENTRIES ||
          Buffer.byteLength(JSON.stringify(entries)) > MAX_OUTPUT_BYTES
        ) {
          throw new CrankError("payload_too_large", "workspace listing exceeds the result limit");
        }
        return {
          type: "list-result",
          path: relative(yield* call(() => realpath(root)), path) || ".",
          entries,
          workspaceVersion,
        };
      }
      case "write": {
        if (Buffer.byteLength(request.content) > MAX_FILE_BYTES) {
          throw new CrankError("payload_too_large", "workspace write exceeds the file limit");
        }
        const path = yield* workspacePath(request.path, true);
        yield* call(() => mkdir(dirname(path), { recursive: true }));
        const temporary = `${path}.sweatpants-${sha256(request.operationId).slice(0, 12)}.tmp`;
        try {
          yield* call(() =>
            writeFile(temporary, request.content, { encoding: "utf8", flag: "wx" }),
          );
          yield* call(() => rename(temporary, path));
        } finally {
          yield* call(() => rm(temporary, { force: true }));
        }
        workspaceVersion = nextWorkspaceVersion(workspaceVersion, requestDigest, {
          path: request.path,
          contentDigest: sha256(request.content),
        });
        const response: WorkspaceResponse = {
          type: "write-result",
          path: relative(yield* call(() => realpath(root)), path),
          bytes: Buffer.byteLength(request.content),
          workspaceVersion,
        };
        commitOperation(request.operationId, { requestDigest, response });
        return structuredClone(response);
      }
      case "run-script": {
        const command = scripts[request.script];
        if (!command) {
          throw new CrankError("policy_unavailable", `script is not declared: ${request.script}`);
        }
        let stdout = "";
        let stderr = "";
        let exitCode = 0;
        try {
          const signal = yield* useAbortSignal();
          const result = yield* call(() =>
            executeScript(command, root, signal, options.maximumCommandMs ?? 120_000),
          );
          stdout = boundedOutput(result.stdout);
          stderr = boundedOutput(result.stderr);
        } catch (error) {
          const failure = error as { code?: number | string; stdout?: string; stderr?: string };
          exitCode = typeof failure.code === "number" ? failure.code : 1;
          stdout = boundedOutput(failure.stdout ?? "");
          stderr = boundedOutput(
            failure.stderr ?? (error instanceof Error ? error.message : String(error)),
          );
        }
        // Declared scripts are opaque guest execution and may mutate any workspace
        // byte. Advance the mutation frontier conservatively even when the script
        // fails so a caller holding the pre-script version cannot CAS over it.
        workspaceVersion = nextWorkspaceVersion(workspaceVersion, requestDigest, {
          script: request.script,
          outcome: "executed",
        });
        const response: WorkspaceResponse = {
          type: "script-result",
          script: request.script,
          exitCode,
          stdout,
          stderr,
          workspaceVersion,
        };
        commitOperation(request.operationId, { requestDigest, response });
        return structuredClone(response);
      }
    }
  }

  function commitOperation(operationId: string, operation: CommittedOperation): void {
    committed.set(operationId, operation);
    while (committed.size > MAX_COMMITTED_OPERATIONS) {
      const oldest = committed.keys().next();
      if (oldest.done) {
        break;
      }
      committed.delete(oldest.value);
    }
  }

  function* handle(request: Request): Operation<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({
        ready: activeFence !== undefined,
        fence: activeFence,
        workspaceVersion,
      });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/workspace") {
      return errorResponse(404, "invalid_request", "unknown workspace endpoint");
    }
    try {
      const body = yield* readBoundedBody(request, MAX_BODY_BYTES);
      return Response.json(yield* execute(parseWorkspaceRequest(body)));
    } catch (error) {
      const code = error instanceof CrankError ? error.code : "internal_error";
      const status =
        code === "sandbox_generation_stale" ? 409 : code === "internal_error" ? 500 : 400;
      return errorResponse(status, code, boundedMessage(error));
    }
  }

  function* workspacePath(value: string, allowMissing: boolean): Operation<string> {
    const safe = safeRelativePath(value);
    const actualRoot = yield* call(() => realpath(root));
    const boundary = `${actualRoot}/`;
    const candidate = resolve(actualRoot, safe);
    if (candidate !== actualRoot && !candidate.startsWith(boundary)) {
      throw new CrankError("network_policy_denied", "path escapes workspace");
    }
    if (allowMissing) {
      const parent = yield* call(() => realpath(dirname(candidate)));
      if (parent !== actualRoot && !parent.startsWith(boundary)) {
        throw new CrankError("network_policy_denied", "path parent escapes workspace");
      }
      return candidate;
    }
    const actual = yield* call(() => realpath(candidate));
    if (actual !== actualRoot && !actual.startsWith(boundary)) {
      throw new CrankError("network_policy_denied", "resolved path escapes workspace");
    }
    return actual;
  }

  return {
    initialWorkspaceVersion,
    bind,
    currentFence: () => (activeFence ? structuredClone(activeFence) : undefined),
    currentWorkspaceVersion: () => workspaceVersion,
    execute,
    handle,
  };
}

export interface NodeHttpServerHandle {
  readonly server: Server;
  readonly port: number;
}

/** Scope-owned Node HTTP ingress; every request runs as an owned child operation. */
export function useNodeHttpServer(options: {
  readonly port: number;
  readonly host?: string;
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Operation<void>;
}): Operation<NodeHttpServerHandle> {
  return resource(function* (provide) {
    const scope = yield* useScope();
    const server = createServer((request, response) => {
      const taskReference: { current?: Task<void> } = {};
      const disconnect = () => {
        if (!response.writableEnded) {
          void taskReference.current?.halt().catch(() => undefined);
        }
      };
      request.once("aborted", disconnect);
      response.once("close", disconnect);
      const task = scope.run(function* () {
        try {
          yield* options.handle(request, response);
        } finally {
          request.off("aborted", disconnect);
          response.off("close", disconnect);
        }
      });
      taskReference.current = task;
      task.catch((error) => {
        if (!response.headersSent && !response.destroyed) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              error: { code: "internal_error", message: boundedMessage(error) },
            }),
          );
        }
      });
    });
    yield* call(
      () =>
        new Promise<void>((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(options.port, options.host ?? "0.0.0.0", () => {
            server.off("error", rejectListen);
            resolveListen();
          });
        }),
    );
    try {
      yield* provide({ server, port: options.port });
    } finally {
      yield* call(
        () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
                return;
              }
              resolveClose();
            });
            server.closeIdleConnections();
          }),
      );
    }
  });
}

export function createLoopbackWorkspaceConnector(service: WorkspaceService): WorkspaceConnector {
  return {
    *request(request) {
      return yield* service.execute(request);
    },
  };
}

export function createHttpWorkspaceConnector(options: {
  readonly endpoint: string;
  readonly headers?: () => Operation<Readonly<Record<string, string>>>;
  readonly fetch?: typeof globalThis.fetch;
}): WorkspaceConnector {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    *request(request) {
      const signal = yield* useAbortSignal();
      const headers = options.headers ? yield* options.headers() : {};
      const response = yield* call(() =>
        fetchImplementation(new URL("/workspace", options.endpoint), {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify(request),
        }),
      );
      const body = yield* readBoundedResponseBody(response, MAX_BODY_BYTES);
      if (!response.ok) {
        const error = body as { error?: { code?: string; message?: string } };
        throw new CrankError(
          error.error?.code ?? "sandbox_unavailable",
          error.error?.message ?? `workspace request failed with ${response.status}`,
        );
      }
      return parseWorkspaceResponse(body);
    },
  };
}

export function parseWorkspaceRequest(value: unknown): WorkspaceRequest {
  const input = record(value, "workspace request");
  const type = input["type"];
  const common = {
    protocolVersion: input["protocolVersion"],
    fence: parseFence(input["fence"]),
    operationId: text(input["operationId"], "operation ID"),
  };
  if (common.protocolVersion !== 1) {
    throw new CrankError("invalid_mcp_request", "unsupported workspace protocol version");
  }
  if (type === "inspect") {
    exactKeys(input, ["protocolVersion", "type", "fence", "operationId"]);
    return { ...common, protocolVersion: 1, type };
  }
  const base = {
    ...common,
    workspaceVersion: sha(input["workspaceVersion"], "workspace version"),
  };
  switch (type) {
    case "read":
    case "list":
      exactKeys(input, [
        "protocolVersion",
        "type",
        "fence",
        "operationId",
        "workspaceVersion",
        "path",
      ]);
      return { ...base, protocolVersion: 1, type, path: safeRelativePath(input["path"]) };
    case "write":
      exactKeys(input, [
        "protocolVersion",
        "type",
        "fence",
        "operationId",
        "workspaceVersion",
        "path",
        "content",
      ]);
      return {
        ...base,
        protocolVersion: 1,
        type,
        path: safeRelativePath(input["path"]),
        content: text(input["content"], "workspace content"),
      };
    case "run-script":
      exactKeys(input, [
        "protocolVersion",
        "type",
        "fence",
        "operationId",
        "workspaceVersion",
        "script",
      ]);
      return { ...base, protocolVersion: 1, type, script: text(input["script"], "script") };
    default:
      throw new CrankError("invalid_mcp_request", "unknown workspace request type");
  }
}

export function parseWorkspaceResponse(value: unknown): WorkspaceResponse {
  const input = record(value, "workspace response");
  const workspaceVersion = sha(input["workspaceVersion"], "workspace version");
  switch (input["type"]) {
    case "inspect-result":
      return { type: "inspect-result", workspaceVersion };
    case "read-result":
      return {
        type: "read-result",
        path: safeRelativePath(input["path"]),
        content: text(input["content"], "workspace content"),
        workspaceVersion,
      };
    case "list-result":
      if (
        !Array.isArray(input["entries"]) ||
        input["entries"].length > MAX_LIST_ENTRIES ||
        Buffer.byteLength(JSON.stringify(input["entries"])) > MAX_OUTPUT_BYTES ||
        input["entries"].some((entry) => typeof entry !== "string")
      ) {
        throw new CrankError(
          "invalid_mcp_request",
          "workspace entries must be a bounded string list",
        );
      }
      return {
        type: "list-result",
        path: text(input["path"], "workspace path"),
        entries: [...input["entries"]] as string[],
        workspaceVersion,
      };
    case "write-result":
      return {
        type: "write-result",
        path: safeRelativePath(input["path"]),
        bytes: integer(input["bytes"], "written bytes"),
        workspaceVersion,
      };
    case "script-result":
      return {
        type: "script-result",
        script: text(input["script"], "script"),
        exitCode: integer(input["exitCode"], "exit code"),
        stdout: textValue(input["stdout"], "stdout"),
        stderr: textValue(input["stderr"], "stderr"),
        workspaceVersion,
      };
    default:
      throw new CrankError("invalid_mcp_request", "unknown workspace response type");
  }
}

function normalizeScripts(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [name, command] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
      throw new CrankError("policy_unavailable", `invalid workspace script name: ${name}`);
    }
    if (typeof command !== "string" || command.length < 1 || command.length > 4_096) {
      throw new CrankError("policy_unavailable", `workspace script ${name} is not bounded`);
    }
    output[name] = command;
  }
  return Object.freeze(output);
}

function validateRequest(request: WorkspaceRequest): void {
  parseWorkspaceRequest(request);
}

function validateFence(fence: WorkspaceFence): void {
  parseFence(fence);
}

function parseFence(value: unknown): WorkspaceFence {
  const input = record(value, "workspace fence");
  exactKeys(input, ["taskId", "sandboxGeneration", "activationEpoch"]);
  return {
    taskId: text(input["taskId"], "task ID"),
    sandboxGeneration: text(input["sandboxGeneration"], "sandbox generation"),
    activationEpoch: positiveInteger(input["activationEpoch"], "activation epoch"),
  };
}

function assertFence(expected: WorkspaceFence | undefined, received: WorkspaceFence): void {
  if (!expected || canonicalJson(expected) !== canonicalJson(received)) {
    throw new CrankError("sandbox_generation_stale", "workspace activation fence is stale");
  }
}

function nextWorkspaceVersion(parent: string, operationDigest: string, mutation: Json): string {
  return sha256(
    `sweatpants.workspace-mutation-version.v1\0${canonicalJson({ parent, operationDigest, mutation })}`,
  );
}

function safeRelativePath(value: unknown): string {
  const path = text(value, "workspace path");
  if (path.startsWith("/") || path.includes("\0") || path.split(/[\\/]/).includes("..")) {
    throw new CrankError("network_policy_denied", "path must stay within workspace");
  }
  return path;
}

function* readBoundedBody(request: Request, maximum: number): Operation<unknown> {
  try {
    return yield* readBoundedJsonStream(request.body, maximum);
  } catch (error) {
    if (error instanceof CrankError) {
      throw error;
    }
    throw new CrankError("invalid_mcp_request", "workspace request body must be JSON");
  }
}

function* readBoundedResponseBody(response: Response, maximum: number): Operation<unknown> {
  try {
    return yield* readBoundedJsonStream(response.body, maximum);
  } catch (error) {
    if (error instanceof CrankError && error.code === "payload_too_large") {
      throw new CrankError("sandbox_unavailable", "workspace response exceeds the body limit");
    }
    throw new CrankError("sandbox_unavailable", "workspace response body must be bounded JSON");
  }
}

function* readBoundedJsonStream(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
): Operation<unknown> {
  return yield* call(async () => {
    if (!stream) {
      throw new Error("body is empty");
    }
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        total += next.value.byteLength;
        if (total > maximum) {
          await reader.cancel("body limit exceeded");
          throw new CrankError("payload_too_large", "HTTP body exceeds the limit");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  });
}

function executeScript(
  command: string,
  cwd: string,
  signal: AbortSignal,
  maximumCommandMs: number,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawnProcess("/bin/sh", ["-lc", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let settled = false;

    const killGroup = () => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          child.kill("SIGKILL");
        }
      }
    };
    const append = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - currentBytes);
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
      }
      const nextBytes = currentBytes + chunk.byteLength;
      if (nextBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        killGroup();
      }
      return nextBytes;
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      // A successful shell may have daemonized descendants. The process group
      // belongs exclusively to this operation, so clean it up on every exit.
      killGroup();
    };
    const output = () => ({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
    const reject = (error: Error & { code?: number | string }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectResult(Object.assign(error, output()));
    };
    const onAbort = () => {
      aborted = true;
      killGroup();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (timedOut) {
        reject(Object.assign(new Error("workspace script timed out"), { code: 1 }));
      } else if (aborted) {
        reject(Object.assign(new Error("workspace script was cancelled"), { code: 1 }));
      } else if (outputExceeded) {
        reject(Object.assign(new Error("workspace script output exceeded the limit"), { code: 1 }));
      } else if (code !== 0) {
        reject(
          Object.assign(new Error(`workspace script exited with ${code ?? "signal"}`), {
            code: code ?? 1,
          }),
        );
      } else if (!settled) {
        settled = true;
        cleanup();
        resolveResult(output());
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, maximumCommandMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function boundedOutput(value: string): string {
  return Buffer.byteLength(value) <= MAX_OUTPUT_BYTES
    ? value
    : Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CrankError("invalid_mcp_request", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== allowed.length || actual.some((key) => !allowed.includes(key))) {
    throw new CrankError("invalid_mcp_request", "unknown or missing workspace message field");
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new CrankError("invalid_mcp_request", `${label} must be bounded text`);
  }
  return value;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_OUTPUT_BYTES) {
    throw new CrankError("invalid_mcp_request", `${label} must be bounded text`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new CrankError("invalid_mcp_request", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new CrankError("invalid_mcp_request", `${label} must be a safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const number = integer(value, label);
  if (number < 1) {
    throw new CrankError("invalid_mcp_request", `${label} must be positive`);
  }
  return number;
}
