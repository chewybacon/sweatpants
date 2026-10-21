import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { call, type Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import { record, type LuaState } from "./state.ts";
const executable = fileURLToPath(
  new URL("../vm/target/debug/flowmode-runtime-lua", import.meta.url),
);
const MAX_BYTES = 4 * 1024 * 1024;
/** One scoped native command. Cancellation kills compute and waits for process exit. */
export function* invoke(command: Json): Operation<LuaState> {
  const input = JSON.stringify(command);
  if (Buffer.byteLength(input) > MAX_BYTES) {
    throw Error("Lua command byte budget exceeded");
  }
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "",
    stderr = "",
    received = 0;
  let fault: Error | undefined;
  const fail = (error: Error) => {
    fault ??= error;
    child.kill("SIGKILL");
  };
  const done = new Promise<void>((resolve) => {
    child.on("error", (error) => {
      fault ??= error;
    });
    child.once("close", (code) => {
      if (code !== 0) {
        fault ??= Error(`Lua process failed: ${stderr.trim() || code}`);
      }
      resolve();
    });
  });
  const timer = setTimeout(() => fail(Error("Lua command deadline exceeded")), 10000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    received += Buffer.byteLength(chunk);
    if (received > MAX_BYTES) {
      fail(Error("Lua output byte budget exceeded"));
      return;
    }
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    if (Buffer.byteLength(stderr) < 8192) {
      stderr += chunk.slice(0, 8192);
    }
  });
  child.stdin.on("error", (error) => fail(error));
  try {
    child.stdin.end(input);
    yield* call(() => done);
    if (fault) {
      throw fault;
    }
    return record(JSON.parse(stdout));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    yield* call(() => done);
  }
}
