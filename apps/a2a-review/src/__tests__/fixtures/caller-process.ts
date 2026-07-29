import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { run, type Operation } from "effection";
import {
  withJournalAuthority,
  createCapabilityKeyring,
  createInMemoryDurableJournalAuthority,
  type DurableJournalAuthorityService,
  type DurableSemanticRecord,
} from "@sweatpants/session-contract";
import { ProgramRouteResolverContext } from "@sweatpants/durable-execution";
import { ProgramRuntime } from "@sweatpants/durable-execution";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import {
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createLocalProgramDriver,
} from "@sweatpants/durable-execution";
import { canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import {
  createChatModelEffectRegistration,
  type ChatModelSampleOutputV2,
} from "@sweatpants/framework/chat";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  createA2AProgramDriver,
  createNodeA2AWebSocketConnector,
  preflightRemoteEffectHandlers,
} from "@sweatpants/a2a";
import {
  ASK_PARENT_EFFECT,
  CHAT_MODEL_SAMPLE_EFFECT,
  REFERENCE_REVIEWER_CHAT,
  REFERENCE_REVIEWER_GUIDANCE,
  REFERENCE_REVIEWER_REMOTE,
  createAskParentRegistration,
  createReviewChatInput,
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
const reviewInput: ReviewInput = {
  design: "MULTIPROCESS_DESIGN_ARTIFACT",
  rubric: "MULTIPROCESS_REVIEW_RUBRIC",
  instructions: "Review independently, ask one narrow question, then return a verdict.",
};
const input = createReviewChatInput(reviewInput, "multiprocess-frontier");
const schemaRegistry = createDurableSchemaRegistry([...REFERENCE_REVIEWER_CHAT.schemaCatalog]);
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
      child: REFERENCE_REVIEWER_CHAT.manifest.digest,
    }),
  ),
  inputSchema: REFERENCE_REVIEWER_CHAT.manifest.inputSchema,
  outputSchema: REFERENCE_REVIEWER_CHAT.manifest.outputSchema,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: false, structuredChildren: true, replay: "strict" as const },
};
const parentTool = createPinnedDurableProgram(parentManifest, function* (reviewInput, context) {
  return yield* context.invoke({
    id: REFERENCE_REVIEWER_CHAT.manifest.programId,
    version: REFERENCE_REVIEWER_CHAT.manifest.version,
    digest: REFERENCE_REVIEWER_CHAT.manifest.digest,
    input: reviewInput,
  });
});
const modelRegistration = createChatModelEffectRegistration({
  allowedClassifications: ["internal", "restricted"],
  *sample(_request, context) {
    const existing = effectState.model[context.pullId];
    if (existing !== undefined) {
      return existing as unknown as ChatModelSampleOutputV2;
    }
    effectState.modelExecutions += 1;
    const value: ChatModelSampleOutputV2 =
      effectState.modelExecutions === 1
        ? {
            message: assistantMessage("guidance", "Loading review guidance."),
            calls: [
              {
                id: "guidance-read-1",
                target: "resources.read",
                input: { uri: REFERENCE_REVIEWER_GUIDANCE.entryUri },
              },
            ],
            artifacts: [],
          }
        : effectState.modelExecutions === 2
          ? {
              message: assistantMessage("question", "I need one clarification."),
              calls: [
                {
                  id: "ask-parent-1",
                  target: "ask_parent",
                  input: {
                    question: "Which authority owns accepted progress?",
                    rationale: "durability",
                  },
                },
              ],
              artifacts: [],
            }
          : {
              message: assistantMessage("final", {
                review: {
                  verdict: "pass",
                  summary: "Fresh-process replay preserved the independent review.",
                },
              }),
              calls: [],
              artifacts: [],
            };
    effectState.model[context.pullId] = value;
    persistEffects();
    crashOnce("model_after_provider_commit");
    return value;
  },
});
const askRegistration = createAskParentRegistration({
  context: { contextId: "intentionally-unavailable", digest: "0".repeat(64) },
  store: {
    *context() {
      return undefined;
    },
    *claimQuestion(pullId, budget) {
      if (effectState.claims.includes(pullId)) {
        return "duplicate";
      }
      if (effectState.claims.length >= budget) {
        return "exhausted";
      }
      effectState.claims.push(pullId);
      persistEffects();
      return "allowed";
    },
    *outcome(pullId) {
      return effectState.askOutcomes[pullId];
    },
    *commit(pullId, outcome) {
      const existing = effectState.askOutcomes[pullId];
      if (existing) {
        return existing;
      }
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
  manifest: async (program) => {
    const document = Object.values(REFERENCE_REVIEWER_REMOTE.manifests).find(
      (candidate) => candidate.program.digest === program.digest,
    );
    if (!document) {
      throw new Error("unexpected program");
    }
    preflightRemoteEffectHandlers(document.manifest, effects);
    return document;
  },
  deadlines: { handshakeMs: 2_000, attachMs: 2_000, stepMs: 2_000, restoreProgressMs: 2_000 },
});
const drivers = createProgramDriverRegistry([
  ["program", createLocalProgramDriver(createDurableToolRegistry([parentTool]))],
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
  route: { driverKind: "program" },
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
      return yield* withJournalAuthority(persistedAuthority, function* () {
        return yield* DurableEffectRegistryContext.with(effects, function* () {
          return yield* ProgramRouteResolverContext.with(
            function* (program) {
              return Object.values(REFERENCE_REVIEWER_REMOTE.manifests).some(
                (document) => document.program.digest === program.digest,
              )
                ? {
                    driverKind: "a2a",
                    protocolVersion: 1,
                    extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
                    executionId: `multiprocess-${program.digest.slice(0, 12)}`,
                    driverEndpoint: endpoint,
                    cardOrigin: endpoint.replace("ws:", "http:"),
                  }
                : { driverKind: "program" };
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
  if (!completed) {
    throw new Error("root task did not complete");
  }
  emitResult(completed);
});

function terminalEvidence(records: DurableSemanticRecord[]): Json | undefined {
  const closed = records.find(
    (record) => record.payload.type === "TaskClosed" && record.payload.taskId === rootAttach.taskId,
  );
  if (!closed || closed.payload.type !== "TaskClosed") {
    return undefined;
  }
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
  if (crashStage !== stage || effectState.crashed.includes(stage)) {
    return;
  }
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
      if (typeof value !== "function") {
        return value;
      }
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
function assistantMessage(id: string, value: Json) {
  return {
    id,
    role: "assistant" as const,
    parts: [{ value, provenance: { classifications: [], sourceDigests: [] } }],
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
