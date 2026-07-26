import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "effection";
import {
  DURABLE_INVOCATION_EXTENSION_URI,
  ForeignA2ADurableSession,
  createHttpJsonForeignA2AClient,
  createSecureForeignA2AHttpTransport,
  type ForeignA2AInvocationPin,
} from "../index.ts";

const children = new Set<ChildProcess>();
const repoRoot = resolve(import.meta.dirname, "../../../..");
const fixture = resolve(import.meta.dirname, "fixtures/foreign-server-process.ts");
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  children.clear();
});

describe("foreign A2A independent-process certification", () => {
  it("reconciles response loss without duplicating the remote task and surfaces degraded ambiguity", async () => {
    const reconciled = await scenario("reconciled");
    expect(reconciled.transition).toMatchObject({
      state: { binding: { taskId: "foreign-task-1" } },
      event: { type: "progress" },
    });
    expect(reconciled.creations).toBe(1);

    const continuation = await scenario("continuation");
    expect(continuation.transition).toMatchObject({
      event: { type: "terminal", result: { status: "completed" } },
    });
    expect(continuation.creations).toBe(1);
    expect(continuation.continuations).toBe(1);

    const degraded = await scenario("degraded");
    expect(degraded.transition).toMatchObject({
      event: {
        type: "indeterminate",
        result: { phase: "initial_dispatch", remoteTaskMayExist: true },
      },
    });
    expect(degraded.creations).toBe(1);
  }, 20_000);
});

async function scenario(mode: "reconciled" | "continuation" | "degraded") {
  const port = await reservePort();
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", fixture], {
    cwd: repoRoot,
    env: { ...process.env, FOREIGN_A2A_PORT: String(port), FOREIGN_A2A_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  await waitReady(child);
  const origin = `http://127.0.0.1:${port}`;
  const pin = invocationPin(origin, mode !== "degraded");
  const client = createHttpJsonForeignA2AClient({
    transport: createSecureForeignA2AHttpTransport({
      cardOrigin: origin,
      urlPolicy: { allowLocalhostTests: true },
    }),
  });
  const session = new ForeignA2ADurableSession({ client });
  const started = await run(() =>
    session.start({
      pin,
      message: { messageId: pin.initialMessageId, role: "user", parts: [{ text: "work" }] },
      maxDispatchAttempts: 3,
    }),
  );
  const transition =
    mode === "continuation"
      ? await run(() =>
          session.respond(started.state, {
            pin,
            taskId: "foreign-task-1",
            contextId: "foreign-context-1",
            message: {
              messageId: "msg-continuation-stable",
              role: "user",
              parts: [{ text: "one answer" }],
            },
            maxDispatchAttempts: 3,
          }),
        )
      : started;
  const stats = (await fetch(`${origin}/stats`).then((response) => response.json())) as {
    creations: number;
    continuations: number;
  };
  child.kill("SIGTERM");
  await exited(child);
  return {
    transition,
    creations: stats.creations,
    continuations: stats.continuations,
  };
}

function invocationPin(origin: string, reconciled: boolean): ForeignA2AInvocationPin {
  return {
    cardDigest: "a".repeat(64),
    agentName: "process-agent",
    skillId: "work",
    interface: { url: `${origin}/a2a`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    extensionUris: reconciled ? [DURABLE_INVOCATION_EXTENSION_URI] : [],
    guarantee: reconciled
      ? {
          level: "reconciled",
          source: "durable_invocation_extension",
          negotiatedAt: new Date().toISOString(),
          invocationExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          messageIdempotencyExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          extension: {
            protocolVersion: 1,
            resolveEndpoint: `${origin}/invocations:resolve`,
            abortEndpoint: `${origin}/invocations:abort`,
            messageIdempotency: true,
            retention: {
              invocationBindingSeconds: 300,
              abortTombstoneSeconds: 300,
              messageIdempotencySeconds: 300,
              taskSeconds: 3600,
              terminalResultSeconds: 3600,
              clockSkewSeconds: 5,
            },
          },
        }
      : {
          level: "task_handle_only",
          source: "base_task_handle",
          negotiatedAt: new Date().toISOString(),
        },
    ambiguityPolicy: "surface",
    invocationId: `inv-${reconciled ? "strong" : "degraded"}`,
    initialMessageId: `msg-${reconciled ? "strong" : "degraded"}`,
    requestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    principalId: "cert-caller",
  };
}
function waitReady(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error(`foreign server did not start: ${stdout}`)),
      5_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("READY")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`foreign server exited early: ${code}/${signal}`));
    });
  });
}
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}
async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve port");
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}
