import { createServer } from "node:http";
import {
  DURABLE_INVOCATION_EXTENSION_URI,
  InMemoryDurableInvocationService,
  type ForeignA2ASendResult,
} from "../../index.ts";

const port = Number(process.env["FOREIGN_A2A_PORT"]);
const mode = process.env["FOREIGN_A2A_MODE"] ?? "reconciled";
if (!Number.isSafeInteger(port) || port <= 0) {
  throw new Error("FOREIGN_A2A_PORT is required");
}
let creations = 0;
let continuations = 0;
let dropFirst = mode !== "continuation";
let dropContinuation = mode === "continuation";
const service = new InMemoryDurableInvocationService({
  retention: {
    invocationBindingSeconds: 300,
    abortTombstoneSeconds: 300,
    messageIdempotencySeconds: 300,
    taskSeconds: 3600,
    terminalResultSeconds: 3600,
    clockSkewSeconds: 5,
  },
});
const normalized: ForeignA2ASendResult = {
  type: "task",
  task: {
    id: "foreign-task-1",
    contextId: "foreign-context-1",
    status:
      mode === "continuation"
        ? {
            state: "input_required",
            message: {
              messageId: "remote-question-1",
              role: "agent",
              parts: [{ text: "Please answer once" }],
            },
          }
        : { state: "working" },
    artifacts: [],
  },
};
const completed: ForeignA2ASendResult = {
  type: "task",
  task: {
    id: "foreign-task-1",
    contextId: "foreign-context-1",
    status: { state: "completed" },
    artifacts: [],
  },
};

const server = createServer(async (request, response) => {
  const body = await readBody(request);
  if (request.url === "/a2a/message:send" && request.method === "POST") {
    const extension = body?.metadata?.[DURABLE_INVOCATION_EXTENSION_URI];
    let result = normalized;
    const isContinuation = mode === "continuation" && Boolean(body?.message?.taskId);
    if (isContinuation) {
      result = await service.processMessage(
        {
          principalId: "cert-caller",
          invocationId: String(extension.invocationId),
          messageId: String(extension.messageId),
          messageDigest: String(extension.messageDigest),
          requestExpiresAt: String(extension.requestExpiresAt),
          taskId: String(body.message.taskId),
          contextId: String(body.message.contextId),
        },
        async () => {
          continuations += 1;
          return completed;
        },
      );
    } else if ((mode === "reconciled" || mode === "continuation") && extension) {
      result = await service.create(
        {
          principalId: "cert-caller",
          invocationId: String(extension.invocationId),
          messageId: String(extension.messageId),
          messageDigest: String(extension.messageDigest),
          requestExpiresAt: String(extension.requestExpiresAt),
        },
        async () => {
          creations += 1;
          return normalized;
        },
      );
    } else {
      creations += 1;
    }
    if (dropFirst || (isContinuation && dropContinuation)) {
      dropFirst = false;
      dropContinuation = false;
      request.socket.destroy();
      return;
    }
    send(
      response,
      200,
      wireResult(result),
      mode === "reconciled" || mode === "continuation"
        ? { "A2A-Extensions": DURABLE_INVOCATION_EXTENSION_URI }
        : {},
    );
    return;
  }
  if (request.url === "/invocations:resolve" && request.method === "POST") {
    const result = await service.resolve({
      principalId: "cert-caller",
      invocationId: String(body?.invocationId),
      messageDigest: String(body?.messageDigest),
      requestExpiresAt: String(body?.requestExpiresAt),
    });
    send(
      response,
      200,
      result.status === "bound" ? { ...result, result: wireResult(result.result) } : result,
      { "A2A-Extensions": DURABLE_INVOCATION_EXTENSION_URI },
    );
    return;
  }
  if (request.url === "/invocations:abort" && request.method === "POST") {
    const result = await service.abort({
      principalId: "cert-caller",
      invocationId: String(body?.invocationId),
      messageDigest: String(body?.messageDigest),
      requestExpiresAt: String(body?.requestExpiresAt),
    });
    send(
      response,
      200,
      result.status === "bound" ? { ...result, result: wireResult(result.result) } : result,
      { "A2A-Extensions": DURABLE_INVOCATION_EXTENSION_URI },
    );
    return;
  }
  if (request.url === "/stats") {
    send(response, 200, { creations, continuations });
    return;
  }
  send(response, 404, { error: { message: "not found" } });
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`READY ${port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

async function readBody(request: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}
function wireResult(result: ForeignA2ASendResult): any {
  if (result.type === "message") {
    return { message: result.message };
  }
  return {
    task: {
      id: result.task.id,
      contextId: result.task.contextId,
      status: {
        state: `TASK_STATE_${result.task.status.state.toUpperCase()}`,
        ...(result.task.status.message
          ? {
              message: {
                ...result.task.status.message,
                role: result.task.status.message.role === "agent" ? "ROLE_AGENT" : "ROLE_USER",
              },
            }
          : {}),
      },
      artifacts: result.task.artifacts,
    },
  };
}
function send(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/a2a+json", ...headers });
  response.end(JSON.stringify(body));
}
