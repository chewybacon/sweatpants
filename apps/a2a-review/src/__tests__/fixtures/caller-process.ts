import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { run, type Operation } from "effection";
import {
  DurableEffectRegistryContext,
  FOREIGN_MODEL_SAMPLE_EFFECT,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRouteResolverContext,
  ProgramRuntime,
  canonicalJson,
  createCapabilityKeyring,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableSchemaRegistry,
  createDurableTool,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createLocalGeneratorDriver,
  createProgramDriverRegistry,
  foreignToolSchemaEntries,
  sha256,
  type DurableJournalAuthorityService,
  type DurableSemanticRecord,
  type Json,
} from "@sweatpants/session-contract";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  createA2AProgramDriver,
  createNodeA2AWebSocketConnector,
  createRemoteProgramManifestDocument,
  preflightRemoteEffectHandlers,
} from "@sweatpants/a2a";
import {
  ASK_PARENT_EFFECT,
  REFERENCE_REVIEWER_TOOL,
  REFERENCE_REVIEW_SCHEMA_ENTRIES,
  createAskParentRegistration,
  type AskParentOutput,
  type ReviewInput,
} from "../../index.ts";

const stateDir = required("A2A_CERT_STATE_DIR");
const endpoint = required("A2A_CERT_ENDPOINT");
const crashStage = process.env["A2A_CALLER_CRASH_STAGE"];
const snapshotPath = `${stateDir}/authority.json`;
const effectStatePath = `${stateDir}/effects.json`;

type EffectState = {
  model: Record<string, Json>;
  elicit: Record<string, AskParentOutput>;
  askOutcomes: Record<string, AskParentOutput>;
  claims: string[];
  modelExecutions: number;
  elicitExecutions: number;
  crashed: string[];
};
const effectState: EffectState = readJson(effectStatePath, {
  model: {},
  elicit: {},
  askOutcomes: {},
  claims: [],
  modelExecutions: 0,
  elicitExecutions: 0,
  crashed: [],
});
const input: ReviewInput = {
  design: "MULTIPROCESS_DESIGN_ARTIFACT",
  rubric: "MULTIPROCESS_REVIEW_RUBRIC",
  instructions: "Review independently, ask one narrow question, then return a verdict.",
};
const foreignSchemas = foreignToolSchemaEntries();
const schemaRegistry = createDurableSchemaRegistry([
  ...REFERENCE_REVIEW_SCHEMA_ENTRIES,
  ...foreignSchemas,
]);
const keyring = createCapabilityKeyring("a2a-multiprocess-certification", [
  { keyId: "certification-key", secret: "certification-secret-at-least-32-bytes" },
]);
const snapshot = existsSync(snapshotPath)
  ? JSON.parse(readFileSync(snapshotPath, "utf8"))
  : undefined;
const authority = createInMemoryDurableJournalAuthority({
  journalId: "a2a-multiprocess-certification",
  journalIncarnation: "certification-1",
  keyring,
  schemaRegistry,
  ...(snapshot ? { snapshot } : {}),
});
const persistAuthority = () => atomicJson(snapshotPath, authority.exportSnapshot());
const persistedAuthority = persistAfterOperations(authority, persistAuthority);

const parentManifest = {
  programId: "reference.multiprocess-review-parent",
  version: "1.0.0",
  digest: sha256(
    canonicalJson({
      artifact: "reference.multiprocess-review-parent/v1",
      child: REFERENCE_REVIEWER_TOOL.manifest.digest,
    }),
  ),
  inputSchema: REFERENCE_REVIEWER_TOOL.manifest.inputSchema,
  outputSchema: REFERENCE_REVIEWER_TOOL.manifest.outputSchema,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: false, structuredChildren: true, replay: "strict" as const },
};
const parentTool = createDurableTool(parentManifest, function* (reviewInput, context) {
  return yield* context.invoke({
    id: REFERENCE_REVIEWER_TOOL.manifest.programId,
    version: REFERENCE_REVIEWER_TOOL.manifest.version,
    digest: REFERENCE_REVIEWER_TOOL.manifest.digest,
    input: reviewInput,
  });
});
const modelInput = foreignSchemas.find(
  (entry) => entry.descriptor.digest === FOREIGN_MODEL_SAMPLE_EFFECT.inputSchema.digest,
)!;
const modelOutput = foreignSchemas.find(
  (entry) => entry.descriptor.digest === FOREIGN_MODEL_SAMPLE_EFFECT.outputSchema.digest,
)!;
const modelRegistration = createDurableEffectRegistration(
  FOREIGN_MODEL_SAMPLE_EFFECT,
  { mode: "idempotent", mechanism: "pull_id_key" },
  function* (_request, context) {
    const existing = effectState.model[context.pullId];
    if (existing !== undefined) return { status: "ok", value: existing };
    effectState.modelExecutions += 1;
    const value: Json =
      effectState.modelExecutions === 1
        ? { question: "Which authority owns accepted progress?", rationale: "durability" }
        : { verdict: "pass", summary: "Fresh-process replay preserved the independent review." };
    effectState.model[context.pullId] = value;
    persistEffects();
    crashOnce("model_after_provider_commit");
    return { status: "ok", value };
  },
  { input: modelInput.schema, output: modelOutput.schema },
);
const askRegistration = createAskParentRegistration({
  context: { contextId: "intentionally-unavailable", digest: "0".repeat(64) },
  store: {
    *context() {
      return undefined;
    },
    *claimQuestion(pullId, budget) {
      if (effectState.claims.includes(pullId)) return "duplicate";
      if (effectState.claims.length >= budget) return "exhausted";
      effectState.claims.push(pullId);
      persistEffects();
      return "allowed";
    },
    *outcome(pullId) {
      return effectState.askOutcomes[pullId];
    },
    *commit(pullId, outcome) {
      const existing = effectState.askOutcomes[pullId];
      if (existing) return existing;
      effectState.askOutcomes[pullId] = outcome;
      persistEffects();
      return outcome;
    },
  },
  policy: { questionBudget: 1, allowUserEscalation: true, allowQuestion: () => true },
  provider: {
    *answer(): Operation<AskParentOutput> {
      throw new Error("context is intentionally unavailable");
    },
    *elicit(request) {
      const existing = effectState.elicit[request.idempotencyKey];
      if (existing?.status === "answered") {
        return { action: "accept" as const, answer: existing.answer };
      }
      effectState.elicitExecutions += 1;
      effectState.elicit[request.idempotencyKey] = {
        status: "answered",
        answer: "USER_RESPONSE_RECORDED_ONCE",
        source: "user",
      };
      persistEffects();
      crashOnce("elicit_after_response_commit");
      return { action: "accept" as const, answer: "USER_RESPONSE_RECORDED_ONCE" };
    },
  },
});
const effects = createDurableEffectRegistry([modelRegistration, askRegistration]);
const a2aDriver = createA2AProgramDriver({
  connector: createNodeA2AWebSocketConnector({ urlPolicy: { allowLocalhostTests: true } }),
  manifest: async () => {
    preflightRemoteEffectHandlers(REFERENCE_REVIEWER_TOOL.manifest, effects);
    return createRemoteProgramManifestDocument(REFERENCE_REVIEWER_TOOL.manifest);
  },
  deadlines: { handshakeMs: 2_000, attachMs: 2_000, stepMs: 2_000, restoreProgressMs: 2_000 },
});
const drivers = createProgramDriverRegistry([
  ["generator", createLocalGeneratorDriver(createDurableToolRegistry([parentTool]))],
  ["a2a", a2aDriver],
]);
const rootAttach = {
  sessionId: "multiprocess-session",
  taskId: "turn-0/root",
  program: {
    id: parentManifest.programId,
    version: parentManifest.version,
    digest: parentManifest.digest,
  },
  input,
  route: { driverKind: "generator" },
  executionEpoch: 1,
};

await run(function* () {
  const terminal = terminalEvidence(authority.readJournal(rootAttach.sessionId));
  if (terminal) {
    emitResult(terminal);
    return;
  }
  if (!snapshot) {
    yield* authority.openTask({
      sessionId: rootAttach.sessionId,
      turnId: "turn-0",
      taskId: rootAttach.taskId,
      manifest: parentManifest,
      input,
      executionEpoch: 1,
      attachmentId: "unattached",
      audience: "parent-runtime",
    });
    persistAuthority();
  }
  try {
    yield* ProgramDriverRegistryContext.with(drivers, function* () {
      return yield* JournalAuthorityContext.with(persistedAuthority, function* () {
        return yield* DurableEffectRegistryContext.with(effects, function* () {
          return yield* ProgramRouteResolverContext.with(
            function* (program) {
              return program.id === REFERENCE_REVIEWER_TOOL.manifest.programId
                ? {
                    driverKind: "a2a",
                    protocolVersion: 1,
                    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
                    executionId: "multiprocess-review-child",
                    driverEndpoint: endpoint,
                    cardOrigin: endpoint.replace("ws:", "http:"),
                  }
                : { driverKind: "generator" };
            },
            function* () {
              yield* ProgramRuntime.operations.run({
                attach: rootAttach,
                executeHostEffects: true,
              });
            },
          );
        });
      });
    });
  } catch (error) {
    persistAuthority();
    process.stderr.write(`RECOVERABLE ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 75;
    return;
  }
  persistAuthority();
  crashOnce("terminal_after_authority_commit");
  const completed = terminalEvidence(authority.readJournal(rootAttach.sessionId));
  if (!completed) throw new Error("root task did not complete");
  emitResult(completed);
});

function terminalEvidence(records: DurableSemanticRecord[]): Json | undefined {
  const closed = records.find(
    (record) => record.payload.type === "TaskClosed" && record.payload.taskId === rootAttach.taskId,
  );
  if (!closed || closed.payload.type !== "TaskClosed") return undefined;
  return {
    outcome: closed.payload.outcome,
    modelExecutions: effectState.modelExecutions,
    elicitExecutions: effectState.elicitExecutions,
    consultationPulls: records.filter(
      (record) =>
        record.payload.type === "PullRequested" &&
        record.payload.descriptor.kind === "effect" &&
        record.payload.descriptor.name === ASK_PARENT_EFFECT.name,
    ).length,
    taskClosures: records.filter((record) => record.payload.type === "TaskClosed").length,
  };
}

function emitResult(result: Json): void {
  process.stdout.write(`RESULT ${canonicalJson(result)}\n`);
}
function crashOnce(stage: string): void {
  if (crashStage !== stage || effectState.crashed.includes(stage)) return;
  effectState.crashed.push(stage);
  persistEffects();
  process.kill(process.pid, "SIGKILL");
}
function persistEffects(): void {
  atomicJson(effectStatePath, effectState as unknown as Json);
}
function persistAfterOperations(
  target: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  persist: () => void,
): DurableJournalAuthorityService {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        (function* (): Operation<unknown> {
          const result = yield* value.apply(object, args);
          persist();
          return result;
        })();
    },
  }) as unknown as DurableJournalAuthorityService;
}
function atomicJson(path: string, value: Json): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, canonicalJson(value));
  renameSync(temporary, path);
}
function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
