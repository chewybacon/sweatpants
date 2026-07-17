import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import {
  createDurableToolRegistry,
  createLocalGeneratorDriver,
  sha256,
  type ProgramAttachment,
} from "@sweatpants/session-contract";
import {
  ASK_PARENT_EFFECT,
  REFERENCE_ASK_PARENT_TOOL,
  REFERENCE_REVIEWER_AGENT,
  REFERENCE_REVIEWER_ARTIFACT_DIGEST,
  REFERENCE_REVIEWER_CHAT,
  REFERENCE_REVIEWER_REMOTE,
  REFERENCE_REVIEWER_TOOL,
  createAskParentRegistration,
  type AskParentOutput,
  type ConsultationContextRef,
  type ConsultationStore,
} from "../index.ts";

function memoryStore(contextRef?: ConsultationContextRef, content?: string): ConsultationStore {
  const outcomes = new Map<string, AskParentOutput>();
  const claims = new Set<string>();
  return {
    *context(ref) {
      return contextRef && content && ref.digest === contextRef.digest
        ? { content, source: "parent-design.md" }
        : undefined;
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

describe("reference authored consultation application", () => {
  it("pins the reviewer to a generated source artifact digest", () => {
    expect(REFERENCE_REVIEWER_ARTIFACT_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(REFERENCE_REVIEWER_ARTIFACT_DIGEST).size).toBeGreaterThan(8);
    expect(REFERENCE_REVIEWER_TOOL.manifest.digest).toBe(REFERENCE_REVIEWER_ARTIFACT_DIGEST);
  });

  it("projects the acceptance entrypoint through the product caller-authoritative facade", () => {
    expect(REFERENCE_REVIEWER_CHAT.identityProvenance.kind).toBe("generated-artifact");
    expect(REFERENCE_REVIEWER_REMOTE.posture).toBe("remote-executor");
    expect(REFERENCE_REVIEWER_REMOTE.selfCheck().ok).toBe(true);
    expect(REFERENCE_REVIEWER_AGENT.manifest.programs.review?.digest).toBe(
      REFERENCE_REVIEWER_CHAT.manifest.digest,
    );
    expect(
      Object.values(REFERENCE_REVIEWER_REMOTE.manifests).some(
        (document) => document.program.digest === REFERENCE_ASK_PARENT_TOOL.manifest.digest,
      ),
    ).toBe(true);
    expect(JSON.stringify(REFERENCE_REVIEWER_REMOTE.card)).not.toContain("Ask one narrow");
  });

  it("uses the effect pull ID for answer idempotency", async () => {
    const content = "The deployment must remain caller-authoritative.";
    const context = {
      contextId: "parent-at-review-start",
      digest: sha256(content),
    };
    const store = memoryStore(context, content);
    let answers = 0;
    const registration = createAskParentRegistration({
      context,
      store,
      policy: { questionBudget: 2, allowUserEscalation: false, allowQuestion: () => true },
      provider: {
        *answer(request): Operation<AskParentOutput> {
          answers += 1;
          return { status: "answered", answer: request.context, source: request.source };
        },
      },
    });
    const effectContext = {
      sessionId: "session",
      taskId: "child",
      pullId: "pull-ask-1",
      attemptId: "attempt-1",
      cancellation: new AbortController().signal,
      resolver: { audience: "caller:reference-review" },
    };
    const first = await run(() =>
      registration.handler({ question: "What is authoritative?" }, effectContext),
    );
    const duplicate = await run(() =>
      registration.handler({ question: "What is authoritative?" }, effectContext),
    );
    expect(first).toEqual(duplicate);
    expect(answers).toBe(1);
  });

  it("returns typed non-answers without implicit escalation", async () => {
    const registration = createAskParentRegistration({
      context: { contextId: "missing", digest: "0".repeat(64) },
      store: memoryStore(),
      policy: { questionBudget: 1, allowUserEscalation: false, allowQuestion: () => true },
      provider: {
        *answer(): Operation<AskParentOutput> {
          throw new Error("must not answer without pinned context");
        },
      },
    });
    const outcome = await run(() =>
      registration.handler(
        { question: "Missing?" },
        {
          sessionId: "session",
          taskId: "child",
          pullId: "pull-missing",
          attemptId: "attempt",
          cancellation: new AbortController().signal,
          resolver: { audience: "caller:reference-review" },
        },
      ),
    );
    expect(outcome).toEqual({
      status: "ok",
      value: { status: "unknown", reason: "pinned consultation context is unavailable" },
    });
  });

  it("durably supports explicitly enabled user escalation", async () => {
    const store = memoryStore();
    let elicits = 0;
    const registration = createAskParentRegistration({
      context: { contextId: "missing", digest: "0".repeat(64) },
      store,
      policy: { questionBudget: 1, allowUserEscalation: true, allowQuestion: () => true },
      provider: {
        *answer(): Operation<AskParentOutput> {
          throw new Error("must not answer without pinned context");
        },
        *elicit() {
          elicits += 1;
          return { action: "accept" as const, answer: "USER_RECORDED_ANSWER" };
        },
      },
    });
    const effectContext = {
      sessionId: "session",
      taskId: "child",
      pullId: "pull-user-escalation",
      attemptId: "attempt",
      cancellation: new AbortController().signal,
      resolver: { audience: "caller:reference-review" },
    };
    const first = await run(() =>
      registration.handler({ question: "Can the user clarify?" }, effectContext),
    );
    const replay = await run(() =>
      registration.handler({ question: "Can the user clarify?" }, effectContext),
    );
    expect(first).toEqual({
      status: "ok",
      value: { status: "answered", answer: "USER_RECORDED_ANSWER", source: "user" },
    });
    expect(replay).toEqual(first);
    expect(elicits).toBe(1);
  });

  it("keeps initial model context clean and introduces parent data only after the recorded effect", async () => {
    const registry = createDurableToolRegistry([REFERENCE_REVIEWER_TOOL]);
    const driver = createLocalGeneratorDriver(registry);
    const request = {
      sessionId: "session",
      taskId: "review-child",
      program: {
        id: REFERENCE_REVIEWER_TOOL.manifest.programId,
        version: REFERENCE_REVIEWER_TOOL.manifest.version,
        digest: REFERENCE_REVIEWER_TOOL.manifest.digest,
      },
      input: {
        design: "EXPLICIT_DESIGN",
        rubric: "EXPLICIT_RUBRIC",
        instructions: "EXPLICIT_INSTRUCTIONS",
      },
      route: { driverKind: "generator" },
      executionEpoch: 1,
    } as const;
    const evidence = await run(function* () {
      const attachment: ProgramAttachment = yield* driver.attach(request);
      const first = yield* driver.step(attachment, { type: "start", input: request.input });
      if (first.type !== "operation" || first.descriptor.kind !== "effect") {
        throw new Error("first sample missing");
      }
      const second = yield* driver.step(attachment, {
        type: "resume",
        actionIndex: first.actionIndex,
        outcome: { status: "ok", value: { question: "Why this authority model?" } },
        receipt: receipt(first.actionIndex),
        replayed: false,
      });
      if (second.type !== "operation" || second.descriptor.kind !== "effect") {
        throw new Error("consultation missing");
      }
      const third = yield* driver.step(attachment, {
        type: "resume",
        actionIndex: second.actionIndex,
        outcome: { status: "ok", value: { status: "answered", answer: "RECORDED_PARENT_ANSWER" } },
        receipt: receipt(second.actionIndex),
        replayed: false,
      });
      return { first, second, third };
    });
    expect(evidence.first.descriptor.name).toBe("model.sample");
    expect(JSON.stringify(evidence.first.descriptor.input)).not.toContain("RECORDED_PARENT_ANSWER");
    expect(evidence.second.descriptor.name).toBe(ASK_PARENT_EFFECT.name);
    expect(evidence.third).toMatchObject({
      type: "operation",
      descriptor: { name: "model.sample" },
    });
    if (evidence.third.type !== "operation" || evidence.third.descriptor.kind !== "effect") {
      throw new Error("final sample missing");
    }
    expect(JSON.stringify(evidence.third.descriptor.input)).toContain("RECORDED_PARENT_ANSWER");
  });
});

function receipt(actionIndex: number) {
  return {
    sessionId: "session",
    taskId: "review-child",
    pullId: `pull-${actionIndex}`,
    resolutionOffset: `offset-${actionIndex}`,
    outcomeDigest: "a".repeat(64),
    status: "accepted" as const,
  };
}
