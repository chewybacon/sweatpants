import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";

import { run } from "effection";
import { WebSocketServer, type WebSocket } from "ws";

import { createDurableToolRegistry } from "@sweatpants/session-contract";
import {
  createAgentCoreDurableEvaluator,
  encodeAgentCoreProgramMessage,
  parseHostProgramMessage,
  type RuntimeProgramMessage,
} from "@sweatpants/tool-runtime-agentcore/evaluator-runtime";
import { agentCoreDurablePrograms } from "../../yo-chat/src/server/agentcore-durable-programs.ts";

const releaseId = requiredEnvironment("AGENTCORE_DURABLE_RELEASE_ID");
const expectedRegistryDigest = requiredEnvironment("AGENTCORE_DURABLE_REGISTRY_DIGEST");
const workspace = process.env["AGENTCORE_WORKSPACE_PATH"] ?? "/mnt/workspace";
const generationPath = "/tmp/sweatpants-agentcore-compute-generation";
const registry = createDurableToolRegistry(agentCoreDurablePrograms.values());
const registryDigest = digest(JSON.stringify([...registry.keys()].sort()));

if (registryDigest !== expectedRegistryDigest) {
  throw new Error("Durable registry digest does not match release metadata");
}

const sandboxTasks = new Map<string, string>();
let computeGeneration: string;

async function loadComputeGeneration(): Promise<string> {
  try {
    return (await readFile(generationPath, "utf8")).trim();
  } catch {
    const generation = randomUUID();
    await writeFile(generationPath, generation, { encoding: "utf8", flag: "wx" }).catch(async () =>
      readFile(generationPath, "utf8"),
    );
    return (await readFile(generationPath, "utf8")).trim();
  }
}

function runtimeSessionId(request: IncomingMessage): string | undefined {
  const value = request.headers["x-amzn-bedrock-agentcore-runtime-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function safeLog(event: string, fields: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({ event, releaseId, ...fields }));
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_048_576) throw new Error("diagnostic payload too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleDiagnosticInvocation(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const sessionId = runtimeSessionId(request);
  if (!sessionId) {
    sendJson(response, 400, { error: "missing runtime session" });
    return;
  }
  const payload = (await readJson(request)) as Record<string, unknown>;
  const operation = payload["op"];
  if (operation === "runtime_diagnostics") {
    sendJson(response, 200, { computeGeneration, pid: process.pid });
    return;
  }
  const markerName = typeof payload["marker"] === "string" ? payload["marker"] : "marker";
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(markerName)) {
    sendJson(response, 400, { error: "invalid marker" });
    return;
  }
  const markerPath = `${workspace}/${markerName}`;
  if (operation === "storage_write") {
    await mkdir(workspace, { recursive: true });
    const marker = randomUUID();
    const handle = await open(markerPath, "w");
    try {
      await handle.writeFile(marker, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    sendJson(response, 200, {
      acknowledged: true,
      markerDigest: digest(marker),
      computeGeneration,
    });
    return;
  }
  if (operation === "storage_read") {
    try {
      const marker = await readFile(markerPath, "utf8");
      sendJson(response, 200, { present: true, markerDigest: digest(marker), computeGeneration });
    } catch {
      sendJson(response, 200, { present: false, computeGeneration });
    }
    return;
  }
  sendJson(response, 400, { error: "unknown diagnostic operation" });
}

function rejection(
  message: ReturnType<typeof parseHostProgramMessage>,
  code: "sandbox_task_mismatch" | "agentcore_runtime_rejected",
): RuntimeProgramMessage {
  return {
    protocolVersion: 1,
    type: "rejected",
    releaseId,
    taskId: message.taskId,
    activationEpoch: message.activationEpoch,
    payload: { code, message: code },
  };
}

function installSocket(socket: WebSocket, request: IncomingMessage): void {
  const sessionId = runtimeSessionId(request);
  if (!sessionId) {
    socket.close(1008, "missing_session");
    return;
  }
  const evaluator = createAgentCoreDurableEvaluator({
    releaseId,
    registry,
    computeGeneration,
  });
  let chain = Promise.resolve();
  socket.on("message", (data) => {
    chain = chain.then(async () => {
      try {
        const message = parseHostProgramMessage(
          typeof data === "string" ? data : new Uint8Array(Buffer.from(data as Buffer)),
        );
        if (message.type === "restore_begin") {
          const existingTask = sandboxTasks.get(sessionId);
          if (existingTask && existingTask !== message.taskId) {
            socket.send(encodeAgentCoreProgramMessage(rejection(message, "sandbox_task_mismatch")));
            socket.close(1008, "sandbox_task_mismatch");
            return;
          }
          sandboxTasks.set(sessionId, message.taskId);
        }
        const output = await run(() => evaluator.handle(message));
        if (output && socket.readyState === socket.OPEN) {
          socket.send(encodeAgentCoreProgramMessage(output));
        }
      } catch {
        safeLog("agentcore.protocol_rejected");
        socket.close(1002, "program_protocol_error");
      }
    });
  });
}

export async function main(): Promise<void> {
  computeGeneration = await loadComputeGeneration();
  const port = Number(process.env["PORT"] ?? "8080");
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/ping") {
      sendJson(response, 200, { status: "Healthy" });
      return;
    }
    if (request.method === "POST" && request.url === "/invocations") {
      void handleDiagnosticInvocation(request, response).catch(() => {
        sendJson(response, 500, { error: "diagnostic failed" });
      });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  webSockets.on("connection", installSocket);
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://runtime").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  safeLog("agentcore.durable_runtime_ready", {
    programCount: registry.size,
    managedWorkspaceConfigured: workspace === "/mnt/workspace",
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main();
