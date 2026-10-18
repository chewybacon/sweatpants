import { CrankError } from "@sweatpants/durable-execution";
import { spawn as spawnProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  assertJson,
  canonicalJson,
  hasControlCharacter,
  parser,
  sha256,
  sortStrings,
  stableTupleHash,
  type Json,
  canonicalDigest,
} from "@sweatpants/foundation";

import { useProgramExecution } from "@sweatpants/durable-execution";
import { call, resource, useAbortSignal, useScope, type Operation, type Task } from "effection";
import { z } from "zod";

import {
  WorkspaceFiles,
  type WorkspaceFence,
  type WorkspaceOperationExecution,
  type WorkspaceOperations,
} from "./api.ts";

export * from "./sandbox-substrate.ts";

export {
  WorkspaceFiles,
  type WorkspaceFence,
  type WorkspaceFilesApi,
  type WorkspaceObservation,
  type WorkspaceOperationExecution,
  type WorkspaceOperations,
} from "./api.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 10_000;
const MAX_COMMITTED_OPERATIONS = 128;

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
}

interface MutationRequestBase extends RequestBase {
  readonly expectedWorkspaceRevision: string;
}

export type WorkspaceRequest =
  | {
      readonly protocolVersion: 1;
      readonly type: "inspect";
      readonly fence: WorkspaceFence;
      readonly operationId: string;
    }
  | (RequestBase & {
      readonly type: "read";
      readonly path: string;
      readonly startLine?: number;
      readonly endLine?: number;
    })
  | (RequestBase & { readonly type: "list"; readonly path: string })
  | (MutationRequestBase & {
      readonly type: "write";
      readonly path: string;
      readonly contents: string;
    })
  | (MutationRequestBase & { readonly type: "run-script"; readonly script: string });

export type WorkspaceResponse =
  | {
      readonly type: "inspect-result";
      readonly workspaceVersion: string;
    }
  | {
      readonly type: "read-result";
      readonly path: string;
      readonly content: string;
      readonly startLine: number;
      readonly endLine: number;
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

const boundedWorkspaceText = z.string().min(1).max(4_096);
const workspaceDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const workspaceFenceSchema = z.strictObject({
  taskId: boundedWorkspaceText,
  sandboxGeneration: boundedWorkspaceText,
  activationEpoch: z.number().int().positive().safe(),
});
const workspaceRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    protocolVersion: z.literal(1),
    type: z.literal("inspect"),
    fence: workspaceFenceSchema,
    operationId: boundedWorkspaceText,
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    type: z.literal("read"),
    fence: workspaceFenceSchema,
    operationId: boundedWorkspaceText,
    path: boundedWorkspaceText,
    startLine: z.number().int().positive().safe().optional(),
    endLine: z.number().int().positive().safe().optional(),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    type: z.literal("list"),
    fence: workspaceFenceSchema,
    operationId: boundedWorkspaceText,
    path: boundedWorkspaceText,
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    type: z.literal("write"),
    fence: workspaceFenceSchema,
    operationId: boundedWorkspaceText,
    expectedWorkspaceRevision: workspaceDigestSchema,
    path: boundedWorkspaceText,
    contents: boundedWorkspaceText,
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    type: z.literal("run-script"),
    fence: workspaceFenceSchema,
    operationId: boundedWorkspaceText,
    expectedWorkspaceRevision: workspaceDigestSchema,
    script: boundedWorkspaceText,
  }),
]);
const workspaceResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("inspect-result"), workspaceVersion: workspaceDigestSchema }),
  z.strictObject({
    type: z.literal("read-result"),
    path: boundedWorkspaceText,
    content: boundedWorkspaceText,
    startLine: z.number().int().positive().safe(),
    endLine: z.number().int().positive().safe(),
    workspaceVersion: workspaceDigestSchema,
  }),
  z.strictObject({
    type: z.literal("list-result"),
    path: boundedWorkspaceText,
    entries: z.array(z.string()).max(MAX_LIST_ENTRIES),
    workspaceVersion: workspaceDigestSchema,
  }),
  z.strictObject({
    type: z.literal("write-result"),
    path: boundedWorkspaceText,
    bytes: z.number().int().safe(),
    workspaceVersion: workspaceDigestSchema,
  }),
  z.strictObject({
    type: z.literal("script-result"),
    script: boundedWorkspaceText,
    exitCode: z.number().int().safe(),
    stdout: z.string().max(MAX_OUTPUT_BYTES),
    stderr: z.string().max(MAX_OUTPUT_BYTES),
    workspaceVersion: workspaceDigestSchema,
  }),
]);

/** Result-oriented structural parsers for the closed workspace protocol. */
export const workspaceFenceParser = parser(workspaceFenceSchema).map(
  (value): WorkspaceFence => value,
);

export const workspaceRequestParser = parser(workspaceRequestSchema).map(normalizeWorkspaceRequest);

export const workspaceResponseParser = parser(workspaceResponseSchema).map(
  normalizeWorkspaceResponse,
);

export interface WorkspaceConnector {
  request(request: WorkspaceRequest): Operation<WorkspaceResponse>;
}

export interface WorkspaceService {
  readonly initialWorkspaceVersion: string;
  readonly operations: WorkspaceOperations;
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
  const initialWorkspaceVersion = stableTupleHash([
    "sweatpants.workspace.initial.v1",
    options.workspaceId,
  ]);
  let workspaceVersion = initialWorkspaceVersion;
  let activeFence: WorkspaceFence | undefined;
  let scripts = normalizeScripts(options.scripts);
  const committed = new Map<string, CommittedOperation>();

  function bind(fence: WorkspaceFence, nextScripts?: Readonly<Record<string, string>>): void {
    assertWorkspaceFence(fence);
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

  const operations: WorkspaceOperations = {
    *inspect(execution) {
      assertExecution(execution);
      return { workspaceRevision: workspaceVersion };
    },
    *readFile(input, execution) {
      assertExecution(execution);
      const path = yield* workspacePath(input.path, false);
      const stat = yield* call(() => lstat(path));
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new CrankError("payload_too_large", "workspace file is not a bounded regular file");
      }
      const fullContents = yield* call(() => readFile(path, "utf8"));
      const lines = fullContents.split("\n");
      const startLine = lineNumber(input.startLine ?? 1, "startLine");
      const requestedEnd = lineNumber(input.endLine ?? lines.length, "endLine");
      if (requestedEnd < startLine || requestedEnd - startLine > 10_000) {
        throw new CrankError("invalid_descriptor", "workspace line range is invalid or too large");
      }
      const endLine = Math.min(requestedEnd, lines.length);
      const contents = lines.slice(startLine - 1, endLine).join("\n");
      if (Buffer.byteLength(contents) > MAX_OUTPUT_BYTES) {
        throw new CrankError("payload_too_large", "workspace read exceeds the result limit");
      }
      return {
        path: relative(yield* call(() => realpath(root)), path),
        contents,
        startLine,
        endLine,
        workspaceRevision: workspaceVersion,
      };
    },
    *list(input, execution) {
      assertExecution(execution);
      const path = yield* workspacePath(input.path, false);
      const entries = sortStrings(yield* call(() => readdir(path)));
      if (
        entries.length > MAX_LIST_ENTRIES ||
        Buffer.byteLength(JSON.stringify(entries)) > MAX_OUTPUT_BYTES
      ) {
        throw new CrankError("payload_too_large", "workspace listing exceeds the result limit");
      }
      return {
        path: relative(yield* call(() => realpath(root)), path) || ".",
        entries,
        workspaceRevision: workspaceVersion,
      };
    },
    *writeFile(input, execution) {
      const { requestDigest, previous } = beginMutation("write", input, execution);
      if (previous) {
        if (previous.response.type !== "write-result") {
          throw new CrankError("nondeterminism_detected", "operation ID changed mutation kind");
        }
        return {
          path: previous.response.path,
          bytes: previous.response.bytes,
          workspaceRevision: previous.response.workspaceVersion,
        };
      }
      assertExpectedRevision(input.expectedWorkspaceRevision);
      if (Buffer.byteLength(input.contents) > MAX_FILE_BYTES) {
        throw new CrankError("payload_too_large", "workspace write exceeds the file limit");
      }
      const path = yield* workspacePath(input.path, true);
      yield* call(() => mkdir(dirname(path), { recursive: true }));
      const temporary = `${path}.sweatpants-${sha256(execution.operationId).slice(0, 12)}.tmp`;
      try {
        yield* call(() => writeFile(temporary, input.contents, { encoding: "utf8", flag: "wx" }));
        yield* call(() => rename(temporary, path));
      } finally {
        yield* call(() => rm(temporary, { force: true }));
      }
      workspaceVersion = nextWorkspaceVersion(workspaceVersion, requestDigest, {
        path: input.path,
        contentDigest: sha256(input.contents),
      });
      const response: WorkspaceResponse = {
        type: "write-result",
        path: relative(yield* call(() => realpath(root)), path),
        bytes: Buffer.byteLength(input.contents),
        workspaceVersion,
      };
      commitOperation(execution.operationId, { requestDigest, response });
      return { path: response.path, bytes: response.bytes, workspaceRevision: workspaceVersion };
    },
    *runScript(input, execution) {
      const { requestDigest, previous } = beginMutation("run-script", input, execution);
      if (previous) {
        if (previous.response.type !== "script-result") {
          throw new CrankError("nondeterminism_detected", "operation ID changed mutation kind");
        }
        return {
          script: previous.response.script,
          exitCode: previous.response.exitCode,
          stdout: previous.response.stdout,
          stderr: previous.response.stderr,
          workspaceRevision: previous.response.workspaceVersion,
        };
      }
      assertExpectedRevision(input.expectedWorkspaceRevision);
      const command = scripts[input.script];
      if (!command) {
        throw new CrankError("policy_unavailable", `script is not declared: ${input.script}`);
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
      workspaceVersion = nextWorkspaceVersion(workspaceVersion, requestDigest, {
        script: input.script,
        outcome: "executed",
      });
      const response: WorkspaceResponse = {
        type: "script-result",
        script: input.script,
        exitCode,
        stdout,
        stderr,
        workspaceVersion,
      };
      commitOperation(execution.operationId, { requestDigest, response });
      return {
        script: input.script,
        exitCode,
        stdout,
        stderr,
        workspaceRevision: workspaceVersion,
      };
    },
  };

  function* execute(request: WorkspaceRequest): Operation<WorkspaceResponse> {
    // `WorkspaceService.execute` is itself a public structural boundary; its
    // interface type cannot prevent arbitrary extension callers constructing
    // an invalid object.
    request = parseWorkspaceRequest(request);
    const execution = { fence: request.fence, operationId: request.operationId };
    switch (request.type) {
      case "inspect": {
        const result = yield* operations.inspect(execution);
        return { type: "inspect-result", workspaceVersion: result.workspaceRevision };
      }
      case "read": {
        const result = yield* operations.readFile(
          {
            path: request.path,
            startLine: request.startLine,
            endLine: request.endLine,
          },
          execution,
        );
        return {
          type: "read-result",
          path: result.path,
          content: result.contents,
          startLine: result.startLine,
          endLine: result.endLine,
          workspaceVersion: result.workspaceRevision,
        };
      }
      case "list": {
        const result = yield* operations.list({ path: request.path }, execution);
        return {
          type: "list-result",
          path: result.path,
          entries: result.entries,
          workspaceVersion: result.workspaceRevision,
        };
      }
      case "write": {
        const result = yield* operations.writeFile(
          {
            path: request.path,
            contents: request.contents,
            expectedWorkspaceRevision: request.expectedWorkspaceRevision,
          },
          execution,
        );
        return {
          type: "write-result",
          path: result.path,
          bytes: result.bytes,
          workspaceVersion: result.workspaceRevision,
        };
      }
      case "run-script": {
        const result = yield* operations.runScript(
          {
            script: request.script,
            expectedWorkspaceRevision: request.expectedWorkspaceRevision,
          },
          execution,
        );
        return {
          type: "script-result",
          script: result.script,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          workspaceVersion: result.workspaceRevision,
        };
      }
    }
  }

  function assertExecution(execution: WorkspaceOperationExecution): void {
    assertFence(activeFence, execution.fence);
    text(execution.operationId, "operation ID");
  }

  function beginMutation(
    kind: "write" | "run-script",
    input: unknown,
    execution: WorkspaceOperationExecution,
  ): { requestDigest: string; previous?: CommittedOperation } {
    assertExecution(execution);
    const requestDigest = canonicalDigest(assertJson({ kind, input, execution }));
    const previous = committed.get(execution.operationId);
    if (previous && previous.requestDigest !== requestDigest) {
      throw new CrankError("nondeterminism_detected", "operation ID was reused with new input");
    }
    return { requestDigest, previous };
  }

  function assertExpectedRevision(expected: string): void {
    if (expected !== workspaceVersion) {
      throw new CrankError("workspace_conflict", "workspace revision is stale", {
        expected,
        current: workspaceVersion,
      });
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
      return errorResponse(
        status,
        code,
        boundedMessage(error),
        error instanceof CrankError ? error.details : undefined,
      );
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
    operations,
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

/** Installs a direct attachment-scope provider over named semantic operations. */
export function installLocalWorkspaceFilesProvider(options: {
  readonly resolve: () => Operation<{
    readonly operations: WorkspaceOperations;
    readonly fence: WorkspaceFence;
  }>;
}): Operation<void> {
  return WorkspaceFiles.around({
    *inspect() {
      const execution = yield* useProgramExecution();
      const binding = yield* options.resolve();
      return yield* binding.operations.inspect({
        fence: binding.fence,
        operationId: execution.operationId("workspace.inspect"),
      });
    },
    *readFile(args) {
      const execution = yield* useProgramExecution();
      const binding = yield* options.resolve();
      return yield* binding.operations.readFile(args[0], {
        fence: binding.fence,
        operationId: execution.operationId("workspace.read-file"),
      });
    },
    *list(args) {
      const execution = yield* useProgramExecution();
      const binding = yield* options.resolve();
      return yield* binding.operations.list(args[0], {
        fence: binding.fence,
        operationId: execution.operationId("workspace.list"),
      });
    },
    *writeFile(args) {
      const binding = yield* options.resolve();
      return yield* binding.operations.writeFile(args[0], {
        fence: binding.fence,
        operationId: args[1].operationId,
      });
    },
    *runScript(args) {
      const binding = yield* options.resolve();
      return yield* binding.operations.runScript(args[0], {
        fence: binding.fence,
        operationId: args[1].operationId,
      });
    },
  });
}

/** Installs a transport-hiding provider over a finite workspace connector. */
export function installRemoteWorkspaceFilesProvider(options: {
  readonly resolve: () => Operation<{
    readonly connector: WorkspaceConnector;
    readonly fence: WorkspaceFence;
  }>;
}): Operation<void> {
  return WorkspaceFiles.around({
    *inspect() {
      const execution = yield* useProgramExecution();
      const binding = yield* options.resolve();
      const response = yield* binding.connector.request({
        protocolVersion: 1,
        type: "inspect",
        fence: binding.fence,
        operationId: execution.operationId("workspace.inspect"),
      });
      if (response.type !== "inspect-result") {
        throw wrongWorkspaceResponse("inspect");
      }
      return { workspaceRevision: response.workspaceVersion };
    },
    *readFile(args) {
      const execution = yield* useProgramExecution();
      const binding = yield* options.resolve();
      const input = args[0];
      const response = yield* binding.connector.request({
        protocolVersion: 1,
        type: "read",
        fence: binding.fence,
        operationId: execution.operationId("workspace.read-file"),
        path: input.path,
        startLine: input.startLine,
        endLine: input.endLine,
      });
      if (response.type !== "read-result") {
        throw wrongWorkspaceResponse("readFile");
      }
      return {
        path: response.path,
        contents: response.content,
        startLine: response.startLine,
        endLine: response.endLine,
        workspaceRevision: response.workspaceVersion,
      };
    },
    *list(args) {
      const execution = yield* useProgramExecution();
      const binding = yield* options.resolve();
      const response = yield* binding.connector.request({
        protocolVersion: 1,
        type: "list",
        fence: binding.fence,
        operationId: execution.operationId("workspace.list"),
        path: args[0].path,
      });
      if (response.type !== "list-result") {
        throw wrongWorkspaceResponse("list");
      }
      return {
        path: response.path,
        entries: [...response.entries],
        workspaceRevision: response.workspaceVersion,
      };
    },
    *writeFile(args) {
      const binding = yield* options.resolve();
      const response = yield* binding.connector.request({
        protocolVersion: 1,
        type: "write",
        fence: binding.fence,
        operationId: args[1].operationId,
        expectedWorkspaceRevision: args[0].expectedWorkspaceRevision,
        path: args[0].path,
        contents: args[0].contents,
      });
      if (response.type !== "write-result") {
        throw wrongWorkspaceResponse("writeFile");
      }
      return {
        path: response.path,
        bytes: response.bytes,
        workspaceRevision: response.workspaceVersion,
      };
    },
    *runScript(args) {
      const binding = yield* options.resolve();
      const response = yield* binding.connector.request({
        protocolVersion: 1,
        type: "run-script",
        fence: binding.fence,
        operationId: args[1].operationId,
        expectedWorkspaceRevision: args[0].expectedWorkspaceRevision,
        script: args[0].script,
      });
      if (response.type !== "script-result") {
        throw wrongWorkspaceResponse("runScript");
      }
      return {
        script: response.script,
        exitCode: response.exitCode,
        stdout: response.stdout,
        stderr: response.stderr,
        workspaceRevision: response.workspaceVersion,
      };
    },
  });
}

function wrongWorkspaceResponse(method: string): CrankError {
  return new CrankError("sandbox_unavailable", `Workspace ${method} returned the wrong response`);
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
        const error = body as { error?: { code?: string; message?: string; details?: Json } };
        throw new CrankError(
          error.error?.code ?? "sandbox_unavailable",
          error.error?.message ?? `workspace request failed with ${response.status}`,
          error.error?.details,
        );
      }
      return parseWorkspaceResponse(body);
    },
  };
}

export function parseWorkspaceRequest(value: unknown): WorkspaceRequest {
  const parsed = workspaceRequestParser.parse(value);
  if (!parsed.ok) {
    throw new CrankError("invalid_mcp_request", "workspace request shape is invalid");
  }
  return parsed.value;
}

export function parseWorkspaceResponse(value: unknown): WorkspaceResponse {
  const parsed = workspaceResponseParser.parse(value);
  if (!parsed.ok) {
    const hasEntryIssue = parsed.issues.some((issue) => issue.path[0] === "entries");
    throw new CrankError(
      "invalid_mcp_request",
      hasEntryIssue
        ? "workspace entries must be a bounded string list"
        : "workspace response shape is invalid",
    );
  }
  return parsed.value;
}

function normalizeWorkspaceRequest(
  input: z.infer<typeof workspaceRequestSchema>,
): WorkspaceRequest {
  if (input.type === "read") {
    const value = { ...input, path: safeRelativePath(input.path) };
    if (value.startLine === undefined) {
      delete value.startLine;
    }
    if (value.endLine === undefined) {
      delete value.endLine;
    }
    return value;
  }
  if (input.type === "list") {
    return { ...input, path: safeRelativePath(input.path) };
  }
  if (input.type === "write") {
    return { ...input, path: safeRelativePath(input.path) };
  }
  return input;
}

function normalizeWorkspaceResponse(
  input: z.infer<typeof workspaceResponseSchema>,
): WorkspaceResponse {
  if (input.type === "list-result") {
    if (Buffer.byteLength(JSON.stringify(input.entries)) > MAX_OUTPUT_BYTES) {
      throw new CrankError("invalid_mcp_request", "workspace entries exceed the output bound");
    }
    return { ...input, entries: [...input.entries] };
  }
  if (input.type === "read-result" || input.type === "write-result") {
    return { ...input, path: safeRelativePath(input.path) };
  }
  return input;
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

function assertWorkspaceFence(fence: WorkspaceFence): void {
  parseFence(fence);
}

function parseFence(value: unknown): WorkspaceFence {
  const parsed = workspaceFenceParser.parse(value);
  if (!parsed.ok) {
    throw new CrankError("invalid_mcp_request", "workspace fence shape is invalid");
  }
  return parsed.value;
}

function assertFence(expected: WorkspaceFence | undefined, received: WorkspaceFence): void {
  if (!expected || canonicalJson(expected) !== canonicalJson(received)) {
    throw new CrankError("sandbox_generation_stale", "workspace activation fence is stale");
  }
}

function nextWorkspaceVersion(parent: string, operationDigest: string, mutation: Json): string {
  return stableTupleHash([
    "sweatpants.workspace-mutation-version.v1",
    parent,
    operationDigest,
    mutation,
  ]);
}

function safeRelativePath(value: unknown): string {
  const path = text(value, "workspace path");
  if (path.startsWith("/") || hasControlCharacter(path) || path.split(/[\\/]/).includes("..")) {
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

function errorResponse(status: number, code: string, message: string, details?: Json): Response {
  return Response.json(
    {
      error: {
        code,
        message /* CONDITIONAL-SPREAD: Omit absent details from workspace commands and snapshot metadata; explicit undefined is not a portable JSON value. */,
        ...(details === undefined ? {} : { details }),
      },
    },
    { status },
  );
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new CrankError("invalid_mcp_request", `${label} must be bounded text`);
  }
  return value;
}

function lineNumber(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new CrankError("invalid_descriptor", `${label} must be a bounded positive integer`);
  }
  return value;
}
