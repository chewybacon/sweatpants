import { run, sleep, spawn } from "effection";
import { describe, expect, it, vi } from "vitest";

import {
  createLambdaMicrovmWorkspaceLease,
  createLambdaMicrovmWorkspaceManager,
  type AwsCommandRunner,
} from "./index.ts";

function fakeRunner(
  configuration: {
    readonly delayAllocation?: boolean;
    readonly failFirstTermination?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let state = "RUNNING";
  let terminationAttempts = 0;
  const runner: AwsCommandRunner = {
    *run(_service, operation) {
      calls.push(operation);
      switch (operation) {
        case "run-microvm":
          if (configuration.delayAllocation) {
            yield* sleep(10);
          }
          return { microvmId: "microvm-1", endpoint: "workspace.example" };
        case "get-microvm":
          return {
            microvmId: "microvm-1",
            state,
            imageArn: "arn:image",
            imageVersion: "6.0",
          };
        case "create-microvm-auth-token":
          return { authToken: { "X-aws-proxy-auth": "opaque-test-token" } };
        case "suspend-microvm":
          state = "SUSPENDED";
          return { state };
        case "resume-microvm":
          state = "RUNNING";
          return { state };
        case "terminate-microvm":
          terminationAttempts += 1;
          if (configuration.failFirstTermination && terminationAttempts === 1) {
            throw new Error("transient termination failure");
          }
          state = "TERMINATED";
          return { state };
        default:
          throw new Error(`unexpected operation ${operation}`);
      }
    },
  };
  return { runner, calls };
}

const options = {
  imageArn: "arn:image",
  imageVersion: "6.0",
  executionRoleArn: "arn:role",
  region: "us-east-1",
  scripts: { test: "true" },
  idle: { warmSeconds: 300, suspendedSeconds: 28_800, maximumSeconds: 28_800 },
};

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const headers = new Headers(init?.headers);
  expect(headers.get("X-aws-proxy-auth")).toBe("opaque-test-token");
  if (url.pathname === "/activation/bind") {
    return Promise.resolve(Response.json({ workspaceVersion: "a".repeat(64) }));
  }
  if (url.pathname === "/workspace") {
    return Promise.resolve(
      Response.json({ type: "inspect-result", workspaceVersion: "a".repeat(64) }),
    );
  }
  return Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
}

describe("Lambda MicroVM workspace provider", () => {
  it("allocates, authenticates, binds, connects, suspends, resumes, and terminates", async () => {
    const { runner, calls } = fakeRunner();
    await run(function* () {
      const lease = yield* createLambdaMicrovmWorkspaceLease(
        { ...options, runner, fetch: fakeFetch },
        runner,
        "task-1",
      );
      expect(lease.fence).toEqual({
        taskId: "task-1",
        sandboxGeneration: "microvm-1",
        activationEpoch: 1,
      });
      expect(
        yield* lease.connector.request({
          protocolVersion: 1,
          type: "inspect",
          fence: lease.fence,
          operationId: "inspect-1",
        }),
      ).toEqual({ type: "inspect-result", workspaceVersion: "a".repeat(64) });
      yield* lease.suspend();
      yield* lease.resume();
      expect(lease.fence.activationEpoch).toBe(2);
      yield* lease.terminate();
    });
    expect(calls).toContain("run-microvm");
    expect(calls).toContain("create-microvm-auth-token");
    expect(calls).toContain("suspend-microvm");
    expect(calls).toContain("resume-microvm");
    expect(calls).toContain("terminate-microvm");
  });

  it("reuses one task-affine lease and closes it once", async () => {
    const { runner, calls } = fakeRunner();
    const manager = createLambdaMicrovmWorkspaceManager({ ...options, runner, fetch: fakeFetch });
    await run(function* () {
      const context = {
        sessionId: "conversation-1",
        taskId: "task",
        pullId: "pull",
        attemptId: "attempt",
        cancellation: new AbortController().signal,
        resolver: { audience: "workspace" },
      };
      const first = yield* manager.resolve(context);
      const second = yield* manager.resolve({ ...context, pullId: "pull-2" });
      expect(second.fence).toEqual(first.fence);
      yield* manager.close();
      yield* manager.close();
    });
    expect(calls.filter((operation) => operation === "run-microvm")).toHaveLength(1);
    expect(calls.filter((operation) => operation === "terminate-microvm")).toHaveLength(1);
  });

  it("single-flights concurrent resolution for one conversation", async () => {
    const { runner, calls } = fakeRunner({ delayAllocation: true });
    const manager = createLambdaMicrovmWorkspaceManager({ ...options, runner, fetch: fakeFetch });
    const context = {
      sessionId: "conversation-concurrent",
      taskId: "task",
      pullId: "pull-1",
      attemptId: "attempt",
      cancellation: new AbortController().signal,
      resolver: { audience: "workspace" },
    };

    await run(function* () {
      const first = yield* spawn(function* () {
        return yield* manager.resolve(context);
      });
      const second = yield* spawn(function* () {
        return yield* manager.resolve({ ...context, pullId: "pull-2" });
      });
      expect((yield* second).fence).toEqual((yield* first).fence);
      yield* manager.close();
    });

    expect(calls.filter((operation) => operation === "run-microvm")).toHaveLength(1);
    expect(calls.filter((operation) => operation === "terminate-microvm")).toHaveLength(1);
  });

  it("terminates an allocation when readiness fails before lease registration", async () => {
    const calls: string[] = [];
    const runner: AwsCommandRunner = {
      *run(_service, operation) {
        calls.push(operation);
        switch (operation) {
          case "run-microvm":
            return { microvmId: "microvm-failed", endpoint: "workspace.example" };
          case "get-microvm":
            return {
              microvmId: "microvm-failed",
              state: "FAILED",
              imageArn: "arn:image",
              imageVersion: "7.0",
            };
          case "terminate-microvm":
            return {};
          default:
            throw new Error(`unexpected operation ${operation}`);
        }
      },
    };

    await expect(
      run(function* () {
        yield* createLambdaMicrovmWorkspaceLease(
          { ...options, runner, fetch: fakeFetch },
          runner,
          "task-failed",
        );
      }),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(calls.filter((operation) => operation === "run-microvm")).toHaveLength(1);
    expect(calls.filter((operation) => operation === "terminate-microvm")).toHaveLength(1);
  });

  it("rejects a malformed bind response and compensates the allocation", async () => {
    const { runner, calls } = fakeRunner();
    const malformedFetch: typeof globalThis.fetch = () =>
      Promise.resolve(new Response("upstream failure", { status: 502 }));

    await expect(
      run(function* () {
        yield* createLambdaMicrovmWorkspaceLease(
          { ...options, runner, fetch: malformedFetch },
          runner,
          "task-malformed",
        );
      }),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(calls.filter((operation) => operation === "terminate-microvm")).toHaveLength(1);
  });

  it("retains a lease and retries after transient termination failure", async () => {
    const { runner, calls } = fakeRunner({ failFirstTermination: true });
    const manager = createLambdaMicrovmWorkspaceManager({ ...options, runner, fetch: fakeFetch });
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await run(function* () {
        const context = {
          sessionId: "conversation-retry",
          taskId: "task",
          pullId: "pull",
          attemptId: "attempt",
          cancellation: new AbortController().signal,
          resolver: { audience: "workspace" },
        };
        yield* manager.resolve(context);
        yield* manager.close();
        expect(yield* manager.inspect(context.sessionId)).toMatchObject({ state: "RUNNING" });
        yield* manager.close();
        expect(yield* manager.inspect(context.sessionId)).toBeUndefined();
      });
    } finally {
      report.mockRestore();
    }

    expect(calls.filter((operation) => operation === "terminate-microvm")).toHaveLength(2);
  });
});
