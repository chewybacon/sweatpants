import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {killProcessTree(child);}
  children.clear();
});

describe("standard A2A independent process replacement", () => {
  it("recovers an immutable terminal task and accepts a new turn in the same context", async () => {
    const state = await mkdtemp(join(tmpdir(), "a2a-process-replacement-"));
    const port = 45_680 + Math.floor(Math.random() * 100);
    try {
      let process = await startFixture(state, port);
      const first = await send(port, {
        messageId: "process-first",
        role: "ROLE_USER",
        parts: [{ text: "PROCESS_REPLACEMENT_FIRST" }],
      });
      expect(first.status.state).toBe("TASK_STATE_COMPLETED");

      killProcessTree(process);
      await exited(process);
      children.delete(process);
      process = await startFixture(state, port);

      const recovered = await getTask(port, first.id);
      expect(recovered).toEqual(first);
      const second = await send(port, {
        messageId: "process-second",
        role: "ROLE_USER",
        contextId: first.contextId,
        parts: [{ text: "PROCESS_REPLACEMENT_SECOND" }],
      });
      expect(second.contextId).toBe(first.contextId);
      expect(second.id).not.toBe(first.id);
      expect(second.status.state).toBe("TASK_STATE_COMPLETED");
      expect(await getTask(port, first.id)).toEqual(first);
    } finally {
      if (process.env["KEEP_A2A_PROCESS_STATE"] !== "1") {
        await rm(state, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

async function startFixture(state: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    join(process.cwd(), "../../node_modules/.bin/tsx"),
    ["--conditions=development", "src/server.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        YO_A2A_PORT: String(port),
        YO_A2A_STATE_DIR: state,
        YO_A2A_MODEL_MODE: "scripted",
        YO_A2A_BEARER_TOKEN: "inspector-bearer-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  children.add(child);
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    output += String(chunk);
  });
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (output.includes("yo-a2a-ready")) {
          clearInterval(timer);
          resolve();
        } else if (child.exitCode !== null) {
          clearInterval(timer);
          reject(new Error(`Fixture exited before readiness:\n${output}`));
        }
      }, 20);
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Fixture readiness timed out:\n${output}`)), 10_000),
    ),
  ]);
  return child;
}

async function send(port: number, message: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/a2a/message:send`, {
    method: "POST",
    headers: {
      authorization: "Bearer inspector-bearer-secret",
      "content-type": "application/a2a+json",
      connection: "close",
    },
    body: JSON.stringify({ message }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { task: TaskWire };
  return body.task;
}
async function getTask(port: number, taskId: string) {
  const response = await fetch(`http://127.0.0.1:${port}/a2a/tasks/${encodeURIComponent(taskId)}`, {
    headers: {
      authorization: "Bearer inspector-bearer-secret",
      connection: "close",
    },
  });
  if (response.status !== 200) {
    throw new Error(`GetTask returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as TaskWire;
}
function killProcessTree(child: ChildProcess): void {
  if (!child.pid) {return;}
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {return Promise.resolve();}
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
type TaskWire = {
  id: string;
  contextId: string;
  status: { state: string };
  [key: string]: unknown;
};

describe("multi-elicit workflow across two process replacements (validation-matrix G2)", () => {
  it("parks at each elicitation, survives SIGKILL at both seams, and reserves exactly once", async () => {
    const state = await mkdtemp(join(tmpdir(), "a2a-book-flight-replacement-"));
    const port = 45_800 + Math.floor(Math.random() * 100);
    try {
      // Turn 1: model routes to book_flight; the tool runs the search effect
      // and parks on the pickFlight elicitation.
      let process = await startFixture(state, port);
      const parked = await send(port, {
        messageId: "bf-root",
        role: "ROLE_USER",
        parts: [{ text: "book a flight from AUS to JFK" }],
      });
      expect(parked.status.state).toBe("TASK_STATE_INPUT_REQUIRED");

      // Seam 1: death while parked before flight selection.
      killProcessTree(process);
      await exited(process);
      children.delete(process);
      process = await startFixture(state, port);

      const recovered = await getTask(port, parked.id);
      expect(recovered.status.state).toBe("TASK_STATE_INPUT_REQUIRED");

      // Continuation resolves pickFlight; the tool advances and parks on pickSeat.
      const afterFlight = await send(port, {
        messageId: "bf-flight",
        role: "ROLE_USER",
        taskId: parked.id,
        contextId: parked.contextId,
        parts: [{ text: "1" }],
      });
      expect(afterFlight.id).toBe(parked.id);
      expect(afterFlight.status.state).toBe("TASK_STATE_INPUT_REQUIRED");

      // Seam 2: death while parked between the two elicitations. This is the
      // exact suspension point the degenerate case exists to certify.
      killProcessTree(process);
      await exited(process);
      children.delete(process);
      process = await startFixture(state, port);

      const completed = await send(port, {
        messageId: "bf-seat",
        role: "ROLE_USER",
        taskId: parked.id,
        contextId: parked.contextId,
        parts: [{ text: "3C" }],
      });
      expect(completed.id).toBe(parked.id);
      expect(completed.status.state).toBe("TASK_STATE_COMPLETED");
      const text = JSON.stringify(completed);
      // Reservation ran exactly once with the choices accepted before each death.
      expect(text).toContain("TK-FL001-3C");

      // Retrying the final continuation after completion reconciles, not re-reserves.
      const retried = await send(port, {
        messageId: "bf-seat",
        role: "ROLE_USER",
        taskId: parked.id,
        contextId: parked.contextId,
        parts: [{ text: "3C" }],
      });
      expect(retried).toEqual(completed);
    } finally {
      if (process.env["KEEP_A2A_PROCESS_STATE"] !== "1") {
        await rm(state, { recursive: true, force: true });
      }
    }
  }, 45_000);
});
