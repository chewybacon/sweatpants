import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import {
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRouteResolverContext,
  ProgramRuntime,
  canonicalJson,
  createCapabilityKeyring,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableSchemaRegistry,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createLocalGeneratorDriver,
  createProgramDriverRegistry,
  sha256,
  type Json,
} from "@sweatpants/session-contract";
import {
  createChatModelEffectRegistration,
  type ChatModelSampleOutputV2,
} from "@sweatpants/framework/chat";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  createA2AProgramDriver,
  createA2AProgramExecutor,
  preflightRemoteEffectHandlers,
} from "@sweatpants/a2a";
import { createInProcessA2AConnector } from "@sweatpants/a2a/testing";
import {
  ASK_PARENT_EFFECT,
  CHAT_MODEL_SAMPLE_EFFECT,
  REFERENCE_ASK_PARENT_TOOL,
  REFERENCE_REVIEWER_CHAT,
  REFERENCE_REVIEWER_GUIDANCE,
  REFERENCE_REVIEWER_REMOTE,
  createAskParentRegistration,
  createReviewChatInput,
  type AskParentOutput,
  type ConsultationStore,
  type ReviewInput,
} from "../index.ts";

function assistantMessage(id: string, value: Json) {
  return {
    id,
    role: "assistant" as const,
    parts: [{ value, provenance: { classifications: [], sourceDigests: [] } }],
  };
}

function consultationStore(content: string): ConsultationStore {
  const outcomes = new Map<string, AskParentOutput>();
  const claims = new Set<string>();
  return {
    *context() {
      return { content, source: "pinned-parent-context" };
    },
    *claimQuestion(pullId, budget) {
      if (claims.has(pullId)) {
        return "duplicate";
      }
      if (claims.size >= budget) {
        return "exhausted";
      }
      claims.add(pullId);
      return "allowed";
    },
    *outcome(pullId) {
      return outcomes.get(pullId);
    },
    *commit(pullId, outcome) {
      const existing = outcomes.get(pullId);
      if (existing) {
        return existing;
      }
      outcomes.set(pullId, structuredClone(outcome));
      return outcome;
    },
  };
}

describe("authored chat reviewer composed through caller-authoritative A2A", () => {
  it("certifies guidance-capable chat, ask_parent, and final answer under caller authority", async () => {
    const reviewInput: ReviewInput = {
      design: "DESIGN_ARTIFACT_ONLY",
      rubric: "RUBRIC_ONLY",
      instructions: "Form an independent review and ask one narrow question.",
    };
    const acceptedInput = createReviewChatInput(reviewInput, "acceptance-frontier");
    const contextText =
      "The caller journal is sole authority because duplicate accepted progress is forbidden.";
    const contextRef = { contextId: "parent-context-v1", digest: sha256(contextText) };
    let modelExecutions = 0;
    let consultationExecutions = 0;
    const modelOutcomes = new Map<string, Json>();
    const modelRegistration = createChatModelEffectRegistration({
      allowedClassifications: ["internal", "restricted"],
      *sample(_request, effect) {
        const recorded = modelOutcomes.get(effect.pullId);
        if (recorded !== undefined) {
          return recorded as unknown as ChatModelSampleOutputV2;
        }
        modelExecutions += 1;
        const value: ChatModelSampleOutputV2 =
          modelExecutions === 1
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
            : modelExecutions === 2
              ? {
                  message: assistantMessage("question", "I need one clarification."),
                  calls: [
                    {
                      id: "ask-parent-1",
                      target: "ask_parent",
                      input: {
                        question: "Why must the caller journal remain authoritative?",
                        rationale: "durability",
                      },
                    },
                  ],
                  artifacts: [],
                }
              : {
                  message: assistantMessage("final", {
                    review: { verdict: "pass", summary: "The authority split is coherent." },
                  }),
                  calls: [],
                  artifacts: [],
                };
        modelOutcomes.set(effect.pullId, value);
        return value;
      },
    });
    const askRegistration = createAskParentRegistration({
      context: contextRef,
      store: consultationStore(contextText),
      policy: { questionBudget: 1, allowUserEscalation: false, allowQuestion: () => true },
      provider: {
        *answer(request): Operation<AskParentOutput> {
          consultationExecutions += 1;
          return { status: "answered", answer: request.context, source: request.source };
        },
      },
    });
    const effects = createDurableEffectRegistry([modelRegistration, askRegistration]);
    const parentManifest = {
      programId: "reference.review-parent",
      version: "1.0.0",
      digest: sha256(
        canonicalJson({
          artifact: "reference.review-parent/v2",
          child: REFERENCE_REVIEWER_CHAT.manifest.digest,
        }),
      ),
      inputSchema: REFERENCE_REVIEWER_CHAT.manifest.inputSchema,
      outputSchema: REFERENCE_REVIEWER_CHAT.manifest.outputSchema,
      elicits: {},
      effects: {},
      capabilities: {
        durableEmissions: false,
        structuredChildren: true,
        replay: "strict" as const,
      },
    };
    const parentTool = createPinnedDurableProgram(parentManifest, function* (input, context) {
      return yield* context.invoke({
        id: REFERENCE_REVIEWER_CHAT.manifest.programId,
        version: REFERENCE_REVIEWER_CHAT.manifest.version,
        digest: REFERENCE_REVIEWER_CHAT.manifest.digest,
        input,
      });
    });
    const executor = createA2AProgramExecutor({
      executorId: "acceptance-executor",
      computeGeneration: "acceptance-generation-1",
      registry: REFERENCE_REVIEWER_REMOTE.registry,
    });
    const a2aDriver = createA2AProgramDriver({
      connector: createInProcessA2AConnector(executor),
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
    });
    const drivers = createProgramDriverRegistry([
      ["generator", createLocalGeneratorDriver(createDurableToolRegistry([parentTool]))],
      ["a2a", a2aDriver],
    ]);
    const authority = createInMemoryDurableJournalAuthority({
      journalId: "a2a-review-acceptance",
      journalIncarnation: "acceptance-1",
      keyring: createCapabilityKeyring("a2a-review-acceptance", [
        { keyId: "acceptance-key", secret: "acceptance-secret-at-least-32-bytes!!" },
      ]),
      schemaRegistry: createDurableSchemaRegistry([...REFERENCE_REVIEWER_CHAT.schemaCatalog]),
    });
    const rootAttach = {
      sessionId: "acceptance-session",
      taskId: "turn-0/root",
      program: {
        id: parentManifest.programId,
        version: parentManifest.version,
        digest: parentManifest.digest,
      },
      input: acceptedInput,
      route: { driverKind: "generator" },
      executionEpoch: 1,
    };
    await run(function* () {
      yield* authority.openTask({
        sessionId: rootAttach.sessionId,
        turnId: "turn-0",
        taskId: rootAttach.taskId,
        manifest: parentManifest,
        input: acceptedInput,
        executionEpoch: 1,
        attachmentId: "unattached",
        audience: "parent-runtime",
      });
      return yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* JournalAuthorityContext.with(authority, function* () {
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
                      executionId: `remote-${program.digest.slice(0, 12)}`,
                      driverEndpoint: "wss://review.example/programs",
                      cardOrigin: "https://review.example",
                    }
                  : { driverKind: "generator" };
              },
              function* () {
                const result = yield* ProgramRuntime.operations.run({
                  attach: rootAttach,
                  executeHostEffects: true,
                });
                expect(result).toEqual({
                  state: "completed",
                  value: {
                    format: "sweatpants.chat-turn-result.v1",
                    message: assistantMessage("final", {
                      review: { verdict: "pass", summary: "The authority split is coherent." },
                    }),
                    artifacts: [],
                  },
                });
              },
            );
          });
        });
      });
    });
    expect(modelExecutions).toBe(3);
    expect(consultationExecutions).toBe(1);
    const journal = authority.readJournal(rootAttach.sessionId);
    expect(journal.filter((record) => record.payload.type === "TaskOpened")).toHaveLength(4);
    expect(
      journal.some(
        (record) =>
          record.payload.type === "TaskOpened" &&
          record.payload.programDigest ===
            REFERENCE_REVIEWER_CHAT.resourceReaders.read.manifest.digest,
      ),
    ).toBe(true);
    expect(
      journal.filter(
        (record) =>
          record.payload.type === "PullRequested" &&
          record.payload.descriptor.kind === "effect" &&
          record.payload.descriptor.name === ASK_PARENT_EFFECT.name,
      ),
    ).toHaveLength(1);
  });

  it("fails manifest preflight before execution for missing handlers or runtime validators", () => {
    expect(() =>
      preflightRemoteEffectHandlers(
        REFERENCE_REVIEWER_CHAT.manifest,
        createDurableEffectRegistry([]),
      ),
    ).toThrowError(expect.objectContaining({ code: "effect_handler_missing" }));

    const registrationWithoutSchemas = createDurableEffectRegistration(
      ASK_PARENT_EFFECT,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* () {
        return { status: "ok", value: { status: "unknown" as const } };
      },
    );
    expect(() =>
      preflightRemoteEffectHandlers(
        REFERENCE_ASK_PARENT_TOOL.manifest,
        createDurableEffectRegistry([registrationWithoutSchemas]),
      ),
    ).toThrowError(expect.objectContaining({ code: "effect_contract_mismatch" }));
  });
});
