import { fork } from "node:child_process";
import { resolve } from "node:path";
import type { TestApplicationFactoryContext } from "@sweatpants/test-rig";

/** Only OS process lifecycle and HTTP forwarding; no recovery assertions. */
export function createHostProcess(
  context: TestApplicationFactoryContext,
  database: string,
  effectLog: string,
) {
  let current: Awaited<ReturnType<typeof start>> | undefined;
  const children = new Set<ReturnType<typeof fork>>();
  async function start() {
    let diagnostics = "";
    const child = fork(resolve("__tests__/host-crash/fixtures/host.ts"), [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.add(child);
    child.stdout?.on("data", (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-6000);
    });
    child.stderr?.on("data", (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-6000);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => {
        children.delete(child);
        resolve({ code, signal });
      }),
    );
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Child host readiness timed out: ${diagnostics}`));
      }, 10_000);
      child.once("message", (message: { origin: string }) => {
        clearTimeout(timer);
        resolve(message.origin);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Child host exited ${code}/${signal}: ${diagnostics}`));
      });
      child.send({
        database,
        effectLog,
        model: context.model.model,
        streamOptions: context.model.streamOptions,
      });
    });
    return { child, origin, exited };
  }
  return {
    async start() {
      current = await start();
      return current.child.pid;
    },
    async kill() {
      if (!current) {
        throw new Error("No child host is running");
      }
      current.child.kill("SIGKILL");
      return await current.exited;
    },
    async handle(request: Request) {
      if (!current) {
        throw new Error("No child host is running");
      }
      const url = new URL(request.url);
      return fetch(new URL(url.pathname + url.search, current.origin), {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer(),
        signal: request.signal,
      });
    },
    async close() {
      await Promise.all(
        [...children].map(
          (child) =>
            new Promise<void>((resolve) => {
              child.once("exit", () => resolve());
              child.kill("SIGKILL");
            }),
        ),
      );
    },
  };
}
