import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import {
  A2A_EXTENSIONS_HEADER,
  bindA2AExecutorWebSocket,
  createA2AProgramExecutor,
  parseActivatedA2AExtensions,
} from "@sweatpants/a2a";
import { REFERENCE_REVIEWER_REMOTE } from "../../index.ts";

const port = Number(process.env["A2A_CERT_PORT"]);
const crashMarker = process.env["A2A_EXECUTOR_CRASH_MARKER"];
if (!Number.isSafeInteger(port) || port <= 0) throw new Error("A2A_CERT_PORT is required");

const executor = createA2AProgramExecutor({
  executorId: `cert-executor-${process.pid}`,
  computeGeneration: `generation-${process.pid}`,
  registry: REFERENCE_REVIEWER_REMOTE.registry,
  observe(event) {
    if (event.event === "step" && crashMarker && !existsSync(crashMarker)) {
      writeFileSync(crashMarker, "killed-after-step\n");
      process.kill(process.pid, "SIGKILL");
    }
  },
});
const server = createServer();
const webSockets = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });
webSockets.on("connection", (socket, request) => {
  bindA2AExecutorWebSocket(socket, {
    executor,
    principal: { principalId: "certification-caller" },
    activatedExtensions: parseActivatedA2AExtensions(
      request.headers[A2A_EXTENSIONS_HEADER.toLowerCase()],
    ),
  });
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`READY ${port}\n`);
});

const shutdown = () => {
  for (const client of webSockets.clients) client.terminate();
  webSockets.close();
  server.close(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
