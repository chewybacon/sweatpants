import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));

export const YO_CHAT_GENERATED_TOOL_WORKER_ENTRY_URL = pathToFileURL(
  resolve(serverDir, "../__generated__/tool-worker.gen.ts"),
);

const yoChatWorkerExecArgv = ["--conditions=development", "--import", "tsx"];

export const yoChatToolSessionWorkerConfig: {
  workerUrl: URL;
  isDev: false;
  execArgv: string[];
} = {
  workerUrl: pathToFileURL(resolve(serverDir, "./tool-worker-bootstrap.mjs")),
  isDev: false,
  execArgv: [...yoChatWorkerExecArgv],
};

export const yoChatTestToolSessionWorkerConfig: {
  workerUrl: URL;
  isDev: false;
  execArgv: string[];
} = {
  workerUrl: pathToFileURL(resolve(serverDir, "./test-tool-worker.mjs")),
  isDev: false,
  execArgv: [...yoChatWorkerExecArgv],
};
