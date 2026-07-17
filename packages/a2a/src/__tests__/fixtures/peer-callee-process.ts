import { createServer } from "node:http";
import { run } from "effection";
import {
  createCapabilityKeyring,
  createDurableSchemaRegistry,
  createInMemoryDurableJournalAuthority,
} from "@sweatpants/session-contract";
import {
  DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES,
  durableDriverRecoveryFixtureTool,
} from "@sweatpants/session-contract/testing";
import {
  DELEGATED_EFFECTS_EXTENSION_URI,
  SWEATPANTS_PEER_PROFILE_URI,
  InMemoryDelegatedEffectsService,
  type PeerGrantSet,
  type PeerRetentionV1,
} from "../../index.ts";

const port = Number(process.env["PEER_CALLEE_PORT"]);
const grants = JSON.parse(required("PEER_GRANT_SET")) as PeerGrantSet;
const retention = JSON.parse(required("PEER_RETENTION")) as PeerRetentionV1;
const taskId = "peer-task-process";
const invocationId = "peer-invocation-process";
const service = new InMemoryDelegatedEffectsService({ retention });
const authority = createInMemoryDurableJournalAuthority({
  journalId: "peer-callee-authority",
  journalIncarnation: "peer-cert-1",
  keyring: createCapabilityKeyring("peer-callee-authority", [
    { keyId: "peer-callee-key", secret: "peer-callee-authority-secret-at-least-32-bytes" },
  ]),
  schemaRegistry: createDurableSchemaRegistry([...DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES]),
});
await run(() =>
  authority.openTask({
    sessionId: "peer-callee-session",
    turnId: "turn-0",
    taskId,
    manifest: durableDriverRecoveryFixtureTool.manifest,
    input: "peer invocation",
    executionEpoch: 1,
    attachmentId: "callee-journal",
    audience: "peer-callee",
  }),
);
service.createTask({
  taskId,
  invocationId,
  callerIdentity: "caller-process",
  calleeIdentity: "callee-process",
  grantSet: grants,
});
const grant = grants.grants[0]!;
service.appendEffectRequest({
  taskId,
  effectId: "remote-effect-process",
  grantId: grant.grantId,
  grantVersion: grant.grantVersion,
  contractDigest: grant.contract.contractDigest,
  value: "What authority was approved?",
});
let droppedAck = false;
let resolveCalls = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const headers = {
    "content-type": "application/a2a+json",
    "A2A-Extensions": `${SWEATPANTS_PEER_PROFILE_URI},${DELEGATED_EFFECTS_EXTENSION_URI}`,
  };
  if (url.pathname === `/peer/tasks/${taskId}/events` && request.method === "GET") {
    send(
      response,
      service.listEvents(
        taskId,
        Number(url.searchParams.get("afterCursor") ?? 0),
        Number(url.searchParams.get("pageSize") ?? 100),
      ),
      headers,
    );
    return;
  }
  if (
    url.pathname === `/peer/tasks/${taskId}/effects/remote-effect-process` &&
    request.method === "GET"
  ) {
    send(response, service.getEffectStatus(taskId, "remote-effect-process"), headers);
    return;
  }
  if (
    url.pathname === `/peer/tasks/${taskId}/effects/remote-effect-process:resolve` &&
    request.method === "POST"
  ) {
    resolveCalls += 1;
    const body = await jsonBody(request);
    service.resolveEffect(body as never);
    if (!droppedAck) {
      droppedAck = true;
      request.socket.destroy();
      return;
    }
    send(response, service.resolveEffect(body as never), headers);
    return;
  }
  if (url.pathname === "/stats") {
    send(response, {
      resolveCalls,
      status: service.getEffectStatus(taskId, "remote-effect-process"),
      calleeJournalRecords: authority.readJournal("peer-callee-session").length,
    });
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`READY ${port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

function send(
  response: import("node:http").ServerResponse,
  body: unknown,
  headers: Record<string, string>,
): void {
  response.writeHead(200, headers);
  response.end(JSON.stringify(body));
}
async function jsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
