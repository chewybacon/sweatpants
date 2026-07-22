import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import durableProgramWorkerUrl from "./durable-program-worker.ts?modulePath";

const serverDir = dirname(fileURLToPath(import.meta.url));

export const YO_CHAT_TOOL_WORKER_ENTRY_URL = pathToFileURL(resolve(serverDir, "./tool-worker.ts"));

const yoChatWorkerExecArgv = ["--conditions=development", "--import", "tsx"];

export const yoChatToolSessionWorkerConfig: {
  workerUrl: URL;
  isDev: false;
  execArgv: string[];
} = {
  // Source-mode loader shim; its only payload is the exact hand-authored entry
  // represented by YO_CHAT_TOOL_WORKER_ENTRY_URL.
  workerUrl: pathToFileURL(resolve(serverDir, "./tool-worker-bootstrap.mjs")),
  isDev: false,
  execArgv: [...yoChatWorkerExecArgv],
};

export const yoChatDurableProgramWorkerUrl =
  durableProgramWorkerUrl instanceof URL
    ? durableProgramWorkerUrl
    : typeof durableProgramWorkerUrl === "string"
      ? new URL(durableProgramWorkerUrl, import.meta.url)
      : pathToFileURL(resolve(serverDir, "./durable-program-worker-bootstrap.mjs"));

export const yoChatTestToolSessionWorkerConfig: {
  workerUrl: URL;
  isDev: false;
  execArgv: string[];
} = {
  workerUrl: pathToFileURL(resolve(serverDir, "./test-tool-worker.mjs")),
  isDev: false,
  execArgv: [...yoChatWorkerExecArgv],
};
