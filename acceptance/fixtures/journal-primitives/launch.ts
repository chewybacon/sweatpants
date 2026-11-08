import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runScenario, type Engine } from "./scenario.ts";

interface Scenario {
  engine: Engine;
  path: string;
  stop?: number;
  variant?: string;
  recoverPending?: boolean;
}

/** Same scenario and fresh resources, without reloading the framework. */
export async function launchLocal(scenario: Scenario) {
  try {
    return { status: await runScenario(scenario), stdout: "", stderr: "" };
  } catch (error) {
    return {
      status: 1,
      stdout: "",
      stderr: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
}

/** Reserved for abrupt death and genuinely cold recovery assertions. */
export async function launchProcess(scenario: Scenario) {
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--conditions=development",
          "--import",
          "tsx",
          fileURLToPath(new URL("./worker.ts", import.meta.url)),
          scenario.engine,
          scenario.path,
          String(scenario.stop ?? -1),
          scenario.variant ?? "normal",
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: { ...process.env, SEQUENCE_RECOVERY: scenario.recoverPending ? "1" : "0" },
          timeout: 20_000,
          killSignal: "SIGKILL",
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        resolve({ status, stdout, stderr });
      });
    },
  );
}
