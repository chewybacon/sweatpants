import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
import { createServer } from "node:http";
import { run } from "effection";
import {
  withJournalAuthority,
  createCapabilityKeyring,
  createInMemoryDurableJournalAuthority,
} from "@sweatpants/session-contract";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ProgramRuntime } from "@sweatpants/durable-execution";
import {
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createLocalProgramDriver,
} from "@sweatpants/durable-execution";
import { assertJson } from "@sweatpants/foundation";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import { createPortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import {
  DELEGATED_EFFECTS_EXTENSION_URI,
  SWEATPANTS_PEER_PROFILE_URI,
  InMemoryDelegatedEffectsService,
  peerContractAsEffectDefinition,
  type PeerGrantSet,
  type PeerRetentionV1,
} from "../../index.ts";

const port = Number(process.env["PEER_CALLEE_PORT"]);
const grants = JSON.parse(required("PEER_GRANT_SET")) as PeerGrantSet;
const retention = JSON.parse(required("PEER_RETENTION")) as PeerRetentionV1;
const taskId = "peer-task-process";
const invocationId = "peer-invocation-process";
const grant = grants.grants[0]!;
const definition = peerContractAsEffectDefinition(grant.contract);
const programInput = portable("peer-cert/callee-input", "program_input");
const programOutput = portable("peer-cert/callee-output", "program_output");
const calleeTool = createPinnedDurableProgram(
  {
    programId: "peer-cert.callee-task",
    version: "1.0.0",
    digest: "9".repeat(64),
    inputSchema: programInput,
    outputSchema: programOutput,
    elicits: {},
    effects: { [definition.name]: definition },
    capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
  },
  function* (_input, context) {
    return yield* context.effect(definition, "What authority was approved?", {
      audience: "peer:caller-process",
      route: `grant:${grant.grantId}:${grant.grantVersion}`,
    });
  },
);
const authority = createInMemoryDurableJournalAuthority({
  journalId: "peer-callee-authority",
  journalIncarnation: "peer-cert-1",
  keyring: createCapabilityKeyring("peer-callee-authority", [
    { keyId: "peer-callee-key", secret: "peer-callee-authority-secret-at-least-32-bytes" },
  ]),
  schemaRegistry: createDurableSchemaRegistry([
    { descriptor: programInput, schema: anyJsonSchema() },
    { descriptor: programOutput, schema: anyJsonSchema() },
    { descriptor: definition.inputSchema, schema: anyJsonSchema() },
    { descriptor: definition.outputSchema, schema: anyJsonSchema() },
  ]),
});
await run(() =>
  authority.openTask({
    sessionId: "peer-callee-session",
    turnId: "turn-0",
    taskId,
    manifest: calleeTool.manifest,
    input: "peer invocation",
    executionEpoch: 1,
    attachmentId: "callee-journal",
    audience: "peer-callee",
  }),
);
await activateCallee();
const pending = authority
  .readJournal("peer-callee-session")
  .find(
    (record) =>
      record.payload.type === "PullRequested" && record.payload.descriptor.kind === "effect",
  );
if (!pending || pending.payload.type !== "PullRequested") {
  throw new Error("callee authority did not journal its delegated effect request");
}
const resolutionCapability = authority.resolutionCapability(
  "peer-callee-session",
  taskId,
  pending.payload.pullId,
);

const service = new InMemoryDelegatedEffectsService({
  retention,
  validateOutcome(_taskId, _effectId, outcome) {
    if (outcome.status === "ok" && typeof outcome.value !== "string") {
      throw new Error("callee output schema rejected delegated effect response");
    }
  },
});
service.createTask({
  taskId,
  invocationId,
  callerIdentity: "caller-process",
  calleeIdentity: "callee-process",
  grantSet: grants,
});
service.appendEffectRequest({
  taskId,
  effectId: "remote-effect-process",
  grantId: grant.grantId,
  grantVersion: grant.grantVersion,
  contractDigest: grant.contract.contractDigest,
  value: pending.payload.descriptor.kind === "effect" ? pending.payload.descriptor.input : null,
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
    const body = (await jsonBody(request)) as Parameters<typeof service.resolveEffect>[0];
    const ack = service.resolveEffect(body);
    const resolution = await run(() =>
      authority.resolve({
        capability: resolutionCapability,
        audience: "peer:caller-process",
        outcome: body.outcome,
      }),
    );
    if (resolution.status === "rejected") {
      throw new Error(`callee authority rejected peer response: ${resolution.code}`);
    }
    await activateCallee();
    if (!droppedAck) {
      droppedAck = true;
      request.socket.destroy();
      return;
    }
    send(response, ack, headers);
    return;
  }
  if (url.pathname === "/stats") {
    send(
      response,
      {
        resolveCalls,
        status: service.getEffectStatus(taskId, "remote-effect-process"),
        calleeJournalRecords: authority.readJournal("peer-callee-session").length,
        calleeTaskClosures: authority
          .readJournal("peer-callee-session")
          .filter((record) => record.payload.type === "TaskClosed").length,
      },
      headers,
    );
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`READY ${port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

async function activateCallee(): Promise<void> {
  await run(() =>
    ProgramDriverRegistryContext.with(
      createProgramDriverRegistry([
        ["program", createLocalProgramDriver(createDurableToolRegistry([calleeTool]))],
      ]),
      function* () {
        return yield* withJournalAuthority(authority, function* () {
          yield* ProgramRuntime.operations.run({
            attach: {
              sessionId: "peer-callee-session",
              taskId,
              program: {
                id: calleeTool.manifest.programId,
                version: calleeTool.manifest.version,
                digest: calleeTool.manifest.digest,
              },
              input: "peer invocation",
              route: { driverKind: "program" },
              executionEpoch: 1,
            },
            executeHostEffects: false,
          });
        });
      },
    ),
  );
}
function portable(
  identity: string,
  role: Parameters<typeof createPortableSchemaDescriptor>[0]["role"],
) {
  return createPortableSchemaDescriptor({
    identity,
    role,
    version: "1.0.0",
    vendor: "peer-cert",
    inputProjection: true,
    outputProjection: true,
    fidelity: { input: "explicit", output: "explicit" },
  });
}
function anyJsonSchema(): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "peer-cert",
      validate(value: unknown) {
        return { value: assertJson(value) };
      },
    },
  };
}
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
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
