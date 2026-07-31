import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();
const appRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(appRoot, "../..");
const executorScript = resolve(import.meta.dirname, "fixtures/executor-process.ts");
const callerScript = resolve(import.meta.dirname, "fixtures/caller-process.ts");

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  children.clear();
});

describe("caller-authoritative A2A multi-process certification", () => {
  it("kills and replaces executor/caller processes without duplicate model, consultation, user, or terminal outcomes", async () => {
    const stateDir = mkdtempSync(`${tmpdir()}/sweatpants-a2a-cert-`);
    try {
      const port = await reservePort();
      const endpoint = `ws://127.0.0.1:${port}`;
      const executorCrashMarker = resolve(stateDir, "executor-crashed");

      const crashingExecutor = startProcess(executorScript, {
        A2A_CERT_PORT: String(port),
        A2A_EXECUTOR_CRASH_MARKER: executorCrashMarker,
      });
      await waitForLine(crashingExecutor, "READY");
      const transportLossCaller = startCaller(stateDir, endpoint);
      const firstCallerExit = await exited(transportLossCaller);
      const firstExecutorExit = await exited(crashingExecutor);
      expect(firstExecutorExit.signal).toBe("SIGKILL");
      expect(firstCallerExit.code).toBe(75);

      const healthyExecutor = startProcess(executorScript, { A2A_CERT_PORT: String(port) });
      await waitForLine(healthyExecutor, "READY");

      const modelCrash = await exited(
        startCaller(stateDir, endpoint, "model_after_provider_commit"),
      );
      expect(modelCrash.signal).toBe("SIGKILL");

      const elicitCrash = await exited(
        startCaller(stateDir, endpoint, "elicit_after_response_commit"),
      );
      expect(elicitCrash.signal).toBe("SIGKILL");

      const terminalCrash = await exited(
        startCaller(stateDir, endpoint, "terminal_after_authority_commit"),
      );
      expect(terminalCrash.signal).toBe("SIGKILL");

      const recovered = await exited(startCaller(stateDir, endpoint));
      expect(recovered.code).toBe(0);
      const resultLine = recovered.stdout.split("\n").find((line) => line.startsWith("RESULT "));
      if (!resultLine) {
        throw new Error(`Recovered caller emitted no result: ${recovered.stderr}`);
      }
      const evidence = JSON.parse(resultLine.slice("RESULT ".length));
      expect(evidence).toMatchObject({
        outcome: {
          status: "ok",
          value: {
            message: {
              id: "final",
              role: "assistant",
              parts: [
                {
                  value: {
                    review: {
                      verdict: "pass",
                      summary: "Fresh-process replay preserved the independent review.",
                    },
                  },
                },
              ],
            },
            artifacts: [],
          },
        },
        modelExecutions: 3,
        elicitExecutions: 1,
        consultationPulls: 1,
        taskClosures: 4,
      });

      healthyExecutor.kill("SIGTERM");
      await exited(healthyExecutor);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});

function startCaller(stateDir: string, endpoint: string, crashStage?: string): ChildProcess {
  return startProcess(callerScript, {
    A2A_CERT_STATE_DIR: stateDir,
    A2A_CERT_ENDPOINT: endpoint,
    ...(crashStage ? { A2A_CALLER_CRASH_STAGE: crashStage } : {}),
  });
}

function startProcess(script: string, environment: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", script], {
    cwd: repoRoot,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function waitForLine(child: ChildProcess, prefix: string): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${prefix}: ${output}`)),
      5_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const line = output.split("\n").find((candidate) => candidate.startsWith(prefix));
      if (line) {
        clearTimeout(timeout);
        child.stdout?.off("data", onData);
        resolveLine(line);
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Process exited before ${prefix}: code=${code} signal=${signal} output=${output}`,
        ),
      );
    });
  });
}

function exited(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolveExit) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const done = (code: number | null, signal: NodeJS.Signals | null) =>
      resolveExit({ code, signal, stdout, stderr });
    if (child.exitCode !== null || child.signalCode !== null) {
      done(child.exitCode, child.signalCode);
    } else {
      child.once("exit", done);
    }
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve port");
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}
