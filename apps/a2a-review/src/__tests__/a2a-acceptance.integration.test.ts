import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
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
  type Json,
} from "@sweatpants/session-contract";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  createA2AProgramDriver,
  createA2AProgramExecutor,
  createRemoteProgramManifestDocument,
  preflightRemoteEffectHandlers,
} from "@sweatpants/a2a";
import { createInProcessA2AConnector } from "@sweatpants/a2a/testing";
import {
  ASK_PARENT_EFFECT,
  REFERENCE_REVIEWER_TOOL,
  REFERENCE_REVIEW_SCHEMA_ENTRIES,
  createAskParentRegistration,
  type AskParentOutput,
  type ConsultationStore,
  type ReviewInput,
} from "../index.ts";

function consultationStore(content: string): ConsultationStore {
  const outcomes = new Map<string, AskParentOutput>();
  const claims = new Set<string>();
  return {
    *context() {
      return { content, source: "pinned-parent-context" };
    },
    *claimQuestion(pullId, budget) {
      if (claims.has(pullId)) return "duplicate";
      if (claims.size >= budget) return "exhausted";
      claims.add(pullId);
      return "allowed";
    },
    *outcome(pullId) {
      return outcomes.get(pullId);
    },
    *commit(pullId, outcome) {
      const existing = outcomes.get(pullId);
      if (existing) return existing;
      outcomes.set(pullId, structuredClone(outcome));
      return outcome;
    },
  };
}

describe("clean-context reviewer composed through caller-authoritative A2A", () => {
  it("runs a joined remote reviewer through the real authority and caller effect registry", async () => {
    const input: ReviewInput = {
      design: "DESIGN_ARTIFACT_ONLY",
      rubric: "RUBRIC_ONLY",
      instructions: "Form an independent review and ask one narrow question.",
    };
    const contextText =
      "The caller journal is sole authority because duplicate accepted progress is forbidden.";
    const contextRef = { contextId: "parent-context-v1", digest: sha256(contextText) };
    let modelExecutions = 0;
    let consultationExecutions = 0;
    const modelOutcomes = new Map<string, Json>();
    const foreignSchemas = foreignToolSchemaEntries();
    const modelInput = foreignSchemas.find(
      (entry) => entry.descriptor.digest === FOREIGN_MODEL_SAMPLE_EFFECT.inputSchema.digest,
    )!;
    const modelOutput = foreignSchemas.find(
      (entry) => entry.descriptor.digest === FOREIGN_MODEL_SAMPLE_EFFECT.outputSchema.digest,
    )!;
    const modelRegistration = createDurableEffectRegistration(
      FOREIGN_MODEL_SAMPLE_EFFECT,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* (_request, effect) {
        const recorded = modelOutcomes.get(effect.pullId);
        if (recorded !== undefined) return { status: "ok", value: recorded };
        modelExecutions += 1;
        const value: Json =
          modelExecutions === 1
            ? {
                question: "Why must the caller journal remain authoritative?",
                rationale: "durability",
              }
            : { verdict: "pass", summary: "The authority split is coherent." };
        modelOutcomes.set(effect.pullId, value);
        return { status: "ok", value };
      },
      { input: modelInput.schema, output: modelOutput.schema },
    );
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
          artifact: "reference.review-parent/v1",
          child: REFERENCE_REVIEWER_TOOL.manifest.digest,
        }),
      ),
      inputSchema: REFERENCE_REVIEWER_TOOL.manifest.inputSchema,
      outputSchema: REFERENCE_REVIEWER_TOOL.manifest.outputSchema,
      elicits: {},
      effects: {},
      capabilities: {
        durableEmissions: false,
        structuredChildren: true,
        replay: "strict" as const,
      },
    };
    const parentTool = createDurableTool(parentManifest, function* (reviewInput, context) {
      return yield* context.invoke({
        id: REFERENCE_REVIEWER_TOOL.manifest.programId,
        version: REFERENCE_REVIEWER_TOOL.manifest.version,
        digest: REFERENCE_REVIEWER_TOOL.manifest.digest,
        input: reviewInput,
      });
    });
    const remoteRegistry = createDurableToolRegistry([REFERENCE_REVIEWER_TOOL]);
    const executor = createA2AProgramExecutor({
      executorId: "acceptance-executor",
      computeGeneration: "acceptance-generation-1",
      registry: remoteRegistry,
    });
    const a2aDriver = createA2AProgramDriver({
      connector: createInProcessA2AConnector(executor),
      manifest: async (program) => {
        if (program.digest !== REFERENCE_REVIEWER_TOOL.manifest.digest)
          throw new Error("unexpected program");
        preflightRemoteEffectHandlers(REFERENCE_REVIEWER_TOOL.manifest, effects);
        return createRemoteProgramManifestDocument(REFERENCE_REVIEWER_TOOL.manifest);
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
      schemaRegistry: createDurableSchemaRegistry([
        ...REFERENCE_REVIEW_SCHEMA_ENTRIES,
        ...foreignSchemas,
      ]),
    });
    const rootAttach = {
      sessionId: "acceptance-session",
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
      return yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* JournalAuthorityContext.with(authority, function* () {
          return yield* DurableEffectRegistryContext.with(effects, function* () {
            return yield* ProgramRouteResolverContext.with(
              function* (program) {
                return program.id === REFERENCE_REVIEWER_TOOL.manifest.programId
                  ? {
                      driverKind: "a2a",
                      protocolVersion: 1,
                      extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
                      executionId: "remote-review-child",
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
                    review: { verdict: "pass", summary: "The authority split is coherent." },
                  },
                });
              },
            );
          });
        });
      });
    });
    expect(modelExecutions).toBe(2);
    expect(consultationExecutions).toBe(1);
    const journal = authority.readJournal(rootAttach.sessionId);
    expect(journal.filter((record) => record.payload.type === "TaskOpened")).toHaveLength(2);
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
    const effects = createDurableEffectRegistry([]);
    expect(() =>
      preflightRemoteEffectHandlers(REFERENCE_REVIEWER_TOOL.manifest, effects),
    ).toThrowError(expect.objectContaining({ code: "effect_handler_missing" }));

    const registrationWithoutSchemas = createDurableEffectRegistration(
      ASK_PARENT_EFFECT,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* () {
        return { status: "ok", value: { status: "unknown" as const } };
      },
    );
    const askOnlyManifest = {
      ...REFERENCE_REVIEWER_TOOL.manifest,
      effects: { [ASK_PARENT_EFFECT.name]: ASK_PARENT_EFFECT },
    };
    expect(() =>
      preflightRemoteEffectHandlers(
        askOnlyManifest,
        createDurableEffectRegistry([registrationWithoutSchemas]),
      ),
    ).toThrowError(expect.objectContaining({ code: "effect_contract_mismatch" }));
  });
});
