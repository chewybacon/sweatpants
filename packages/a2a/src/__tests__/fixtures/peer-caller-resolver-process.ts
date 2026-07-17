import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { call, run, type Operation } from "effection";
import {
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRuntime,
  canonicalJson,
  createCapabilityKeyring,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableSchemaRegistry,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createLocalGeneratorDriver,
  createProgramDriverRegistry,
  type DurableJournalAuthorityService,
  type Json,
  type StandardSchemaV1,
} from "@sweatpants/session-contract";
import {
  compilePeerResolverBundle,
  peerContractAsEffectDefinition,
  peerResolverTaskId,
  type PeerGrant,
  type PeerResolverInput,
} from "../../index.ts";

const grant = JSON.parse(required("PEER_GRANT")) as PeerGrant;
const input = JSON.parse(required("PEER_RESOLVER_INPUT")) as PeerResolverInput;
const snapshotPath = required("PEER_CALLER_AUTHORITY_SNAPSHOT");
const effectCountPath = required("PEER_EFFECT_COUNT_PATH");
const effectFixture = required("PEER_EFFECT_FIXTURE");
const crashMarker = required("PEER_CALLER_CRASH_MARKER");
const bundle = compilePeerResolverBundle(grant);
const schema = anyJsonSchema();
const snapshot = existsSync(snapshotPath)
  ? JSON.parse(readFileSync(snapshotPath, "utf8"))
  : undefined;
const authority = createInMemoryDurableJournalAuthority({
  journalId: "peer-caller-authority",
  journalIncarnation: "peer-cert-1",
  keyring: createCapabilityKeyring("peer-caller-authority", [
    { keyId: "peer-key", secret: "peer-caller-authority-secret-at-least-32-bytes" },
  ]),
  schemaRegistry: createDurableSchemaRegistry([
    ...bundle.schemaEntries,
    { descriptor: grant.contract.inputSchema, schema },
    { descriptor: grant.contract.outputSchema, schema },
  ]),
  ...(snapshot ? { snapshot } : {}),
});
const persist = () => atomic(snapshotPath, authority.exportSnapshot() as unknown as Json);
const journal = authority.readJournal("peer-caller-session");
const terminal = journal.find(
  (record) => record.payload.type === "TaskClosed" && record.payload.taskId === resolverTaskId(),
);
if (terminal?.payload.type === "TaskClosed") {
  process.stdout.write(`OUTCOME ${canonicalJson(terminal.payload.outcome)}\n`);
  process.exit(0);
}

const definition = peerContractAsEffectDefinition(grant.contract);
const registration = createDurableEffectRegistration(
  definition,
  { mode: "idempotent", mechanism: "pull_id_key" },
  function* (effectInput, context) {
    const outcomePath = `${effectCountPath}.${context.pullId}.json`;
    if (existsSync(outcomePath))
      return { status: "ok", value: JSON.parse(readFileSync(outcomePath, "utf8")) as Json };
    const child = spawn(
      process.execPath,
      ["--conditions=development", "--import", "tsx", effectFixture],
      {
        env: {
          ...process.env,
          PEER_EFFECT_COUNT_PATH: effectCountPath,
          CALLER_ONLY_CREDENTIAL: "CALLER_SECRET_TOKEN",
          HUMAN_APPROVED: "true",
          PEER_EFFECT_INPUT: canonicalJson(effectInput),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = yield* call(() => collect(child));
    const disposition = JSON.parse(output) as { status: "ok"; value: Json };
    writeFileSync(outcomePath, canonicalJson(disposition.value));
    return disposition;
  },
  { input: schema, output: schema },
);

await run(function* () {
  if (!snapshot) {
    yield* authority.openTask({
      sessionId: "peer-caller-session",
      turnId: "turn-0",
      taskId: resolverTaskId(),
      manifest: bundle.tool.manifest,
      input,
      executionEpoch: 1,
      attachmentId: "unattached",
      audience: "peer-resolver",
    });
    persist();
  }
  const service = persistAfterOperations(authority, persist);
  const result = yield* ProgramDriverRegistryContext.with(
    createProgramDriverRegistry([
      ["generator", createLocalGeneratorDriver(createDurableToolRegistry([bundle.tool]))],
    ]),
    function* () {
      return yield* JournalAuthorityContext.with(service, function* () {
        return yield* DurableEffectRegistryContext.with(
          createDurableEffectRegistry([registration]),
          function* () {
            return yield* ProgramRuntime.operations.run({
              attach: {
                sessionId: "peer-caller-session",
                taskId: resolverTaskId(),
                program: {
                  id: bundle.tool.manifest.programId,
                  version: bundle.tool.manifest.version,
                  digest: bundle.tool.manifest.digest,
                },
                input,
                route: { driverKind: "generator" },
                executionEpoch: 1,
              },
              executeHostEffects: true,
            });
          },
        );
      });
    },
  );
  persist();
  if (!existsSync(crashMarker)) {
    writeFileSync(crashMarker, "crashed-after-resolver-terminal\n");
    process.kill(process.pid, "SIGKILL");
  }
  if (result.state !== "completed") throw new Error(`resolver did not complete: ${result.state}`);
  process.stdout.write(`OUTCOME ${canonicalJson(result.value)}\n`);
});

function resolverTaskId(): string {
  return peerResolverTaskId(input.peerTaskId, input.remoteEffectId);
}
function persistAfterOperations(
  target: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  save: () => void,
): DurableJournalAuthorityService {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        (function* (): Operation<unknown> {
          const result = yield* value.apply(object, args);
          save();
          return result;
        })();
    },
  }) as unknown as DurableJournalAuthorityService;
}
function anyJsonSchema(): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "peer-cert",
      validate(value: unknown) {
        return { value: value as Json };
      },
    },
  };
}
function collect(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("exit", (code) =>
      code === 0 ? resolveOutput(stdout) : reject(new Error(`effect executor failed: ${stderr}`)),
    );
  });
}
function atomic(path: string, value: Json): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, canonicalJson(value));
  renameSync(temporary, path);
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
