import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { call, sleep, useAbortSignal, type Operation } from "effection";

import { CrankError, type DurableEffectContext } from "@sweatpants/session-contract";
import {
  createHttpWorkspaceConnector,
  type WorkspaceConnector,
  type WorkspaceFence,
} from "@sweatpants/workspace-runtime";

const execFileAsync = promisify(execFile);

export interface AwsCommandRunner {
  run(service: string, operation: string, args: readonly string[]): Operation<unknown>;
}

export interface LambdaMicrovmWorkspaceOptions {
  readonly imageArn: string;
  readonly imageVersion: string;
  readonly executionRoleArn: string;
  readonly profile?: string;
  readonly region: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly idle: {
    readonly warmSeconds: number;
    readonly suspendedSeconds: number;
    readonly maximumSeconds: number;
  };
  readonly logging?: { readonly logGroup: string };
  readonly runner?: AwsCommandRunner;
  readonly fetch?: typeof globalThis.fetch;
}

export interface LambdaMicrovmWorkspaceLease {
  readonly taskId: string;
  readonly microvmId: string;
  readonly endpoint: string;
  readonly fence: WorkspaceFence;
  readonly connector: WorkspaceConnector;
  readonly initialWorkspaceVersion: string;
  inspect(): Operation<LambdaMicrovmInspection>;
  suspend(): Operation<void>;
  resume(): Operation<void>;
  terminate(): Operation<void>;
}

export interface LambdaMicrovmInspection {
  readonly microvmId: string;
  readonly state: string;
  readonly imageArn: string;
  readonly imageVersion: string;
}

export interface LambdaMicrovmWorkspaceManager {
  resolve(context: DurableEffectContext): Operation<{
    readonly connector: WorkspaceConnector;
    readonly fence: WorkspaceFence;
  }>;
  inspect(taskId: string): Operation<LambdaMicrovmInspection | undefined>;
  close(): Operation<void>;
}

export function createAwsCliCommandRunner(options: {
  readonly profile?: string;
  readonly region: string;
}): AwsCommandRunner {
  return {
    *run(service, operation, args) {
      const signal = yield* useAbortSignal();
      const commandArgs = [
        service,
        operation,
        ...(options.profile ? ["--profile", options.profile] : []),
        "--region",
        options.region,
        ...args,
        "--output",
        "json",
      ];
      try {
        const result = yield* call(() =>
          execFileAsync("aws", commandArgs, {
            signal,
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
          }),
        );
        const output = result.stdout.trim();
        return output.length > 0 ? (JSON.parse(output) as unknown) : {};
      } catch (error) {
        const failure = error as { stderr?: string };
        throw new CrankError(
          "sandbox_unavailable",
          `AWS Lambda MicroVM command failed: ${bounded(failure.stderr ?? String(error))}`,
        );
      }
    },
  };
}

/** Creates a task-affine manager; close terminates every lease it allocated. */
export function createLambdaMicrovmWorkspaceManager(
  options: LambdaMicrovmWorkspaceOptions,
): LambdaMicrovmWorkspaceManager {
  const runner =
    options.runner ??
    createAwsCliCommandRunner({
      ...(options.profile ? { profile: options.profile } : {}),
      region: options.region,
    });
  const leases = new Map<string, LambdaMicrovmWorkspaceLease>();

  return {
    *resolve(context) {
      let lease = leases.get(context.sessionId);
      if (!lease) {
        lease = yield* createLambdaMicrovmWorkspaceLease(options, runner, context.sessionId);
        leases.set(context.sessionId, lease);
      }
      return { connector: lease.connector, fence: lease.fence };
    },
    *inspect(taskId) {
      const lease = leases.get(taskId);
      return lease ? yield* lease.inspect() : undefined;
    },
    *close() {
      const active = [...leases.values()];
      leases.clear();
      for (const lease of active) {
        try {
          yield* lease.terminate();
        } catch (error) {
          console.error("[lambda-microvm] termination failed", {
            microvmId: lease.microvmId,
            error: bounded(error instanceof Error ? error.message : String(error)),
          });
        }
      }
    },
  };
}

export function* createLambdaMicrovmWorkspaceLease(
  options: LambdaMicrovmWorkspaceOptions,
  runner: AwsCommandRunner,
  taskId: string,
): Operation<LambdaMicrovmWorkspaceLease> {
  const runPayload = JSON.stringify({ taskId, activationEpoch: 1, scripts: options.scripts });
  const logging = options.logging
    ? ["--logging", JSON.stringify({ cloudWatch: { logGroup: options.logging.logGroup } })]
    : [];
  const created = record(
    yield* runner.run("lambda-microvms", "run-microvm", [
      "--image-identifier",
      options.imageArn,
      "--image-version",
      options.imageVersion,
      "--execution-role-arn",
      options.executionRoleArn,
      "--ingress-network-connectors",
      JSON.stringify([
        "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS",
      ]),
      "--idle-policy",
      JSON.stringify({
        maxIdleDurationSeconds: options.idle.warmSeconds,
        suspendedDurationSeconds: options.idle.suspendedSeconds,
        autoResumeEnabled: true,
      }),
      "--maximum-duration-in-seconds",
      String(options.idle.maximumSeconds),
      "--run-hook-payload",
      runPayload,
      ...logging,
    ]),
    "run MicroVM response",
  );
  const microvmId = text(created["microvmId"], "MicroVM ID");
  const endpoint = `https://${text(created["endpoint"], "MicroVM endpoint")}`;
  yield* waitForState(runner, microvmId, "RUNNING");

  const fence: WorkspaceFence = {
    taskId,
    sandboxGeneration: microvmId,
    activationEpoch: 1,
  };
  const headers = createTokenHeaders(runner, microvmId);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const bound = record(
    yield* fetchJson(fetchImplementation, new URL("/activation/bind", endpoint), headers, {
      ...fence,
      scripts: options.scripts,
    }),
    "activation bind response",
  );
  const initialWorkspaceVersion = sha(bound["workspaceVersion"], "workspace version");
  const connector = createHttpWorkspaceConnector({ endpoint, headers, fetch: fetchImplementation });
  let terminated = false;

  const lease: LambdaMicrovmWorkspaceLease = {
    taskId,
    microvmId,
    endpoint,
    fence,
    connector,
    initialWorkspaceVersion,
    *inspect() {
      return parseInspection(
        yield* runner.run("lambda-microvms", "get-microvm", ["--microvm-identifier", microvmId]),
      );
    },
    *suspend() {
      yield* runner.run("lambda-microvms", "suspend-microvm", ["--microvm-identifier", microvmId]);
      yield* waitForState(runner, microvmId, "SUSPENDED");
    },
    *resume() {
      yield* runner.run("lambda-microvms", "resume-microvm", ["--microvm-identifier", microvmId]);
      yield* waitForState(runner, microvmId, "RUNNING");
      yield* fetchJson(fetchImplementation, new URL("/activation/bind", endpoint), headers, {
        ...fence,
        scripts: options.scripts,
      });
    },
    *terminate() {
      if (terminated) {
        return;
      }
      terminated = true;
      yield* runner.run("lambda-microvms", "terminate-microvm", [
        "--microvm-identifier",
        microvmId,
      ]);
      yield* waitForState(runner, microvmId, "TERMINATED");
    },
  };
  return lease;
}

function createTokenHeaders(
  runner: AwsCommandRunner,
  microvmId: string,
): () => Operation<Readonly<Record<string, string>>> {
  return function* () {
    const output = record(
      yield* runner.run("lambda-microvms", "create-microvm-auth-token", [
        "--microvm-identifier",
        microvmId,
        "--expiration-in-minutes",
        "5",
        "--allowed-ports",
        JSON.stringify([{ port: 8080 }]),
      ]),
      "auth token response",
    );
    const token = record(output["authToken"], "auth token");
    return {
      "X-aws-proxy-auth": text(token["X-aws-proxy-auth"], "proxy auth token"),
      "X-aws-proxy-port": "8080",
    };
  };
}

function* waitForState(
  runner: AwsCommandRunner,
  microvmId: string,
  expected: string,
): Operation<LambdaMicrovmInspection> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const inspection = parseInspection(
      yield* runner.run("lambda-microvms", "get-microvm", ["--microvm-identifier", microvmId]),
    );
    if (inspection.state === expected) {
      return inspection;
    }
    if (
      inspection.state === "FAILED" ||
      (inspection.state === "TERMINATED" && expected !== "TERMINATED")
    ) {
      throw new CrankError(
        "sandbox_unavailable",
        `MicroVM entered ${inspection.state} while waiting for ${expected}`,
      );
    }
    yield* sleep(2_000);
  }
  throw new CrankError("sandbox_unavailable", `MicroVM did not reach ${expected}`);
}

function* fetchJson(
  fetchImplementation: typeof globalThis.fetch,
  url: URL,
  headers: () => Operation<Readonly<Record<string, string>>>,
  body: unknown,
): Operation<unknown> {
  const signal = yield* useAbortSignal();
  const authentication = yield* headers();
  const response = yield* call(() =>
    fetchImplementation(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...authentication },
      body: JSON.stringify(body),
    }),
  );
  const value = (yield* call(() => response.json())) as unknown;
  if (!response.ok) {
    const error = value as { error?: { code?: string; message?: string } };
    throw new CrankError(
      error.error?.code ?? "sandbox_unavailable",
      error.error?.message ?? `MicroVM HTTP request failed with ${response.status}`,
    );
  }
  return value;
}

function parseInspection(value: unknown): LambdaMicrovmInspection {
  const input = record(value, "MicroVM inspection");
  return {
    microvmId: text(input["microvmId"], "MicroVM ID"),
    state: text(input["state"], "MicroVM state"),
    imageArn: text(input["imageArn"], "image ARN"),
    imageVersion: text(input["imageVersion"], "image version"),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CrankError("sandbox_unavailable", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new CrankError("sandbox_unavailable", `${label} must be bounded text`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  const digest = text(value, label);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new CrankError("sandbox_unavailable", `${label} must be lowercase SHA-256`);
  }
  return digest;
}

function bounded(value: string): string {
  return value.replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]").slice(0, 1_024);
}
