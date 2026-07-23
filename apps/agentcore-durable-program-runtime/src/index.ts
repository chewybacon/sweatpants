import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  decodeDevelopmentCollectionArchive,
  validateCollectionProgramEntries,
  type PublishedCollectionRefV1,
} from "@sweatpants/cli/remote-development-evaluator";
import { run } from "effection";
import { WebSocketServer, type WebSocket } from "ws";

import { createDurableToolRegistry } from "@sweatpants/session-contract";
import {
  createAgentCoreDurableEvaluator,
  encodeAgentCoreProgramMessage,
  parseHostProgramMessage,
  type RuntimeProgramMessage,
} from "@sweatpants/tool-runtime-agentcore/evaluator-runtime";
const releaseId = requiredEnvironment("AGENTCORE_DURABLE_RELEASE_ID");
const developmentBucket = requiredEnvironment("AGENTCORE_DEVELOPMENT_BUCKET");
const developmentPrefix = requiredEnvironment("AGENTCORE_DEVELOPMENT_PREFIX");
const evaluatorAbi = requiredEnvironment("AGENTCORE_DEVELOPMENT_EVALUATOR_ABI");
const region = process.env["AWS_REGION"] ?? "us-east-1";
const workspace = process.env["AGENTCORE_WORKSPACE_PATH"] ?? "/mnt/workspace";
const generationPath = "/tmp/sweatpants-agentcore-compute-generation";
const s3 = new S3Client({ region });
interface LoadedCollection {
  readonly manifest: ReturnType<typeof decodeDevelopmentCollectionArchive>["manifest"];
  readonly registry: ReturnType<typeof createDurableToolRegistry>;
}
const collectionCache = new Map<string, Promise<LoadedCollection>>();

const sandboxTasks = new Map<string, { taskId: string; collectionDigest: string }>();
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
    if (bytes > 1_048_576) {
      throw new Error("diagnostic payload too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loadCollection(collection: PublishedCollectionRefV1): Promise<LoadedCollection> {
  validateCollectionReference(collection);
  const key = `${collection.bucket}\n${collection.key}\n${collection.versionId}\n${collection.objectDigest}`;
  const existing = collectionCache.get(key);
  if (existing) {
    return existing;
  }
  const loading = (async () => {
    const output = await s3.send(
      new GetObjectCommand({
        Bucket: collection.bucket,
        Key: collection.key,
        VersionId: collection.versionId,
      }),
    );
    if (output.VersionId !== collection.versionId || !output.Body) {
      throw new Error("exact collection object version is unavailable");
    }
    const bytes = Uint8Array.from(await output.Body.transformToByteArray());
    if (bytes.byteLength !== collection.bytes) {
      throw new Error("collection object size differs");
    }
    const built = decodeDevelopmentCollectionArchive(bytes, collection.objectDigest);
    if (
      built.manifest.collectionDigest !== collection.collectionDigest ||
      built.manifest.evaluatorAbi !== evaluatorAbi
    ) {
      throw new Error("collection identity or evaluator ABI differs");
    }
    const programs = await validateCollectionProgramEntries(built.manifest, built.files);
    return {
      manifest: built.manifest,
      registry: createDurableToolRegistry(programs.values()),
    };
  })();
  collectionCache.set(key, loading);
  try {
    return await loading;
  } catch (error) {
    collectionCache.delete(key);
    throw error;
  }
}

function validateCollectionReference(value: PublishedCollectionRefV1): void {
  if (
    !value ||
    value.format !== "sweatpants.published-collection.v1" ||
    value.bucket !== developmentBucket ||
    !value.key.startsWith(`${developmentPrefix}/collections/`) ||
    !value.versionId ||
    !/^[0-9a-f]{64}$/u.test(value.objectDigest) ||
    !/^[0-9a-f]{64}$/u.test(value.collectionDigest) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0
  ) {
    throw new Error("collection reference is outside the development environment");
  }
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
  if (operation === "development_collection_readiness") {
    if (payload["evaluatorAbi"] !== evaluatorAbi) {
      sendJson(response, 409, { error: "evaluator_abi_mismatch" });
      return;
    }
    const collection = payload["collection"] as PublishedCollectionRefV1;
    const loaded = await loadCollection(collection);
    sendJson(response, 200, {
      ready: true,
      collectionDigest: loaded.manifest.collectionDigest,
      programCount: loaded.registry.size,
      evaluatorAbi,
      releaseId,
    });
    return;
  }
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

function developmentPlacement(message: ReturnType<typeof parseHostProgramMessage>):
  | {
      readonly collection: PublishedCollectionRefV1;
      readonly publicKey: string;
      readonly runtimeSessionId: string;
    }
  | undefined {
  if (message.type !== "restore_begin") {
    return undefined;
  }
  const route = message.payload.attach.route;
  if (!record(route)) {
    return undefined;
  }
  const placement = route["placement"];
  if (!record(placement)) {
    return undefined;
  }
  const development = placement["development"];
  const placementRuntimeSessionId = placement["runtimeSessionId"];
  if (
    !record(development) ||
    development["evaluatorAbi"] !== evaluatorAbi ||
    typeof development["publicKey"] !== "string" ||
    typeof placementRuntimeSessionId !== "string"
  ) {
    return undefined;
  }
  return {
    collection: development["collection"] as unknown as PublishedCollectionRefV1,
    publicKey: development["publicKey"],
    runtimeSessionId: placementRuntimeSessionId,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function installSocket(socket: WebSocket, request: IncomingMessage): void {
  const sessionId = runtimeSessionId(request);
  if (!sessionId) {
    socket.close(1008, "missing_session");
    return;
  }
  let evaluator: ReturnType<typeof createAgentCoreDurableEvaluator> | undefined;
  let chain = Promise.resolve();
  socket.on("message", (data) => {
    chain = chain.then(async () => {
      try {
        const message = parseHostProgramMessage(
          typeof data === "string" ? data : new Uint8Array(Buffer.from(data as Buffer)),
        );
        if (message.type === "restore_begin") {
          const development = developmentPlacement(message);
          if (!development || development.runtimeSessionId !== sessionId) {
            socket.send(encodeAgentCoreProgramMessage(rejection(message, "sandbox_task_mismatch")));
            socket.close(1008, "sandbox_task_mismatch");
            return;
          }
          const existingTask = sandboxTasks.get(sessionId);
          if (
            existingTask &&
            (existingTask.taskId !== message.taskId ||
              existingTask.collectionDigest !== development.collection.collectionDigest)
          ) {
            socket.send(encodeAgentCoreProgramMessage(rejection(message, "sandbox_task_mismatch")));
            socket.close(1008, "sandbox_task_mismatch");
            return;
          }
          const loaded = await loadCollection(development.collection);
          const entry = loaded.manifest.programs[development.publicKey];
          if (
            !entry ||
            entry.programId !== message.payload.attach.program.id ||
            entry.version !== message.payload.attach.program.version ||
            entry.manifestDigest !== message.payload.attach.program.digest
          ) {
            socket.send(
              encodeAgentCoreProgramMessage(rejection(message, "agentcore_runtime_rejected")),
            );
            socket.close(1008, "program_version_unavailable");
            return;
          }
          sandboxTasks.set(sessionId, {
            taskId: message.taskId,
            collectionDigest: development.collection.collectionDigest,
          });
          evaluator = createAgentCoreDurableEvaluator({
            releaseId,
            registry: loaded.registry,
            computeGeneration,
          });
        }
        if (!evaluator) {
          socket.close(1002, "restore_required");
          return;
        }
        const activeEvaluator = evaluator;
        const output = await run(() => activeEvaluator.handle(message));
        if (output && socket.readyState === socket.OPEN) {
          socket.send(encodeAgentCoreProgramMessage(output));
        }
      } catch {
        safeLog("agentcore.protocol_rejected");
        socket.close(1002, "program_protocol_error");
      }
      return undefined;
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
    dynamicCollections: true,
    managedWorkspaceConfigured: workspace === "/mnt/workspace",
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

void main();
