import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { resource, run, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { installExecutionStore } from "@sweatpants/journal-authority/api";
import { installConversationStore } from "@sweatpants/history-store/port";
import type {
  AcceptPullPreparationRequest,
  ModelContextPreparedFact,
} from "@sweatpants/journal-authority";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import type { ConversationStore, StoredCheckpoint } from "@sweatpants/history-store/contract";
import {
  installModelProvider,
  type Model,
  type ModelContext,
  type ModelProviderDriver,
  type ModelResponse,
  type ModelStreamEvent,
} from "@sweatpants/model-provider";
import {
  decodeModelSampleSourceRequest,
  type ModelSampleAttempt,
  type ModelSampleRequest,
} from "@sweatpants/model-sampling";
import type { ProgramDriverJournal } from "../program-driver-journal.ts";
import {
  createHostModelSamplingService,
  resolveModelContextSource,
  stageProgramDriverModelSampleInput,
} from "../model-sampling/service.ts";

const model: Model = {
  id: "prepared-context-model",
  name: "Prepared context model",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 32_000,
  maxTokens: 1_000,
};

const request: ModelSampleRequest = {
  invocation: {
    context: {
      messages: [{ role: "user", content: "stable prepared input" }],
      tools: [],
    },
  },
  tools: { type: "none" },
  response: { type: "message" },
};

const attempt: ModelSampleAttempt = {
  executor: "host",
  placement: {
    journal: { id: "journal-1", incarnation: "1" },
    program: { id: "nested-program", version: "1", digest: "a".repeat(64) },
    route: { driverKind: "program" },
    driverKind: "program",
  },
  sessionId: "conversation-1",
  taskId: "turn-1/root.0",
  pullId: "pull-1",
  attemptId: "attempt-1",
  effectContractDigest: "b".repeat(64),
  cancellation: new AbortController().signal,
};

function completedResponse(): Stream<ModelStreamEvent, ModelResponse> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<ModelStreamEvent, ModelResponse>> {
        return {
          done: true,
          value: {
            message: { role: "assistant", content: [{ type: "text", text: "done" }] },
            source: null,
            usage: null,
            stopReason: "stop",
            responseId: null,
            errorMessage: null,
          },
        };
      },
    });
  });
}

function checkpoint(): StoredCheckpoint {
  return {
    checkpointId: "checkpoint-1",
    conversationId: "conversation-1",
    lineageId: "lineage-1",
    causeKey: "command-1",
    cause: { kind: "test" },
    contentHash: "c".repeat(64),
    archiveHead: null,
    archiveFrontierOrdinal: "0",
    nextPublicPosition: "1",
    payload: { public: { hotRoots: [], applicationState: {} } },
    encodedBytes: 64,
    createdAt: 1,
  };
}

function conversationStore(): ConversationStore {
  const storedCheckpoint = checkpoint();
  return {
    *loadHead() {
      return {
        conversationId: "conversation-1",
        revision: "2",
        ownerEpoch: "1",
        ownerRoute: null,
        state: "running" as const,
        checkpoint: { checkpointId: storedCheckpoint.checkpointId },
        terminalHistory: null,
        activeLogicalTurnId: "turn-1",
        activeExecutionId: "execution-1",
        latestCompletedExecutionId: null,
        activeSegment: {},
        activeCommand: { commandId: "command-1" },
        deletedAt: null,
        updatedAt: 1,
      };
    },
    *getCheckpoint() {
      return storedCheckpoint;
    },
    *readPublicHistoryBefore() {
      return { roots: [], nextBeforePosition: null };
    },
  } as unknown as ConversationStore;
}

function journalAuthority(state: {
  preparation: ModelContextPreparedFact | null;
}): ProgramDriverJournal {
  return {
    *pullPreparation() {
      return state.preparation;
    },
    *acceptPullPreparation(request_: AcceptPullPreparationRequest) {
      state.preparation = request_.fact;
      return { status: "accepted" as const };
    },
    *authorizeModelDispatch(request_: {
      executionId: string;
      taskId: string;
      pullId: string;
      expectedOwnerFence: string;
      invocationDigest: string;
    }) {
      if (
        !state.preparation ||
        state.preparation.executionId !== request_.executionId ||
        state.preparation.taskId !== request_.taskId ||
        state.preparation.pullId !== request_.pullId ||
        state.preparation.invocationDigest !== request_.invocationDigest
      ) {
        return { status: "identity_conflict" as const };
      }
      return { status: "authorized" as const, fact: state.preparation };
    },
    *acceptAssistantPartial() {
      return { status: "accepted" as const };
    },
  } as unknown as ProgramDriverJournal;
}

describe("accepted model-context preparation", () => {
  it("resolves a conversation source against the selected authoritative checkpoint", async () => {
    await run(function* () {
      yield* installConversationStore(conversationStore());
      const resolved = yield* resolveModelContextSource(
        {
          type: "conversation",
          conversationId: "conversation-1",
          checkpoint: { checkpointId: "checkpoint-1" },
          acceptedCommandId: "command-1",
          executionId: "execution-1",
          taskId: "turn-1/root",
          taskJournalFrontier: "frontier-1",
        },
        { maxCanonicalBytes: 64 * 1024 },
      );
      expect(resolved).toEqual({ messages: [], tools: [] });
    });
  });

  it("stores before dispatch and reuses exact immutable provider input on retry", async () => {
    const contexts: ModelContext[] = [];
    const driver: ModelProviderDriver = {
      *stream(providerRequest) {
        contexts.push(providerRequest.context);
        return completedResponse();
      },
      *sample() {
        throw new Error("stream seam only");
      },
    };
    const state: { preparation: ModelContextPreparedFact | null } = { preparation: null };
    const objects = createMemoryExecutionStore();
    let objectWrites = 0;
    const observedObjects: ExecutionStore = {
      ...objects,
      *putObject(object) {
        objectWrites += 1;
        return yield* objects.putObject(object);
      },
    };

    await run(function* () {
      yield* installExecutionStore(observedObjects);
      yield* installModelProvider(driver);
      const service = createHostModelSamplingService({
        model,
        journal: journalAuthority(state),
        conversationStore: conversationStore(),
        conversationId: "conversation-1",
        emitLiveEvents: false,
      });

      expect((yield* service.sample(request, attempt)).status).toBe("ok");
      expect(state.preparation).not.toBeNull();
      expect(objectWrites).toBe(1);
      expect(contexts).toHaveLength(1);

      expect((yield* service.sample(request, attempt)).status).toBe("ok");
      expect(objectWrites).toBe(1);
      expect(contexts).toHaveLength(2);
      expect(canonicalSnapshot(contexts[1]).canonical).toBe(
        canonicalSnapshot(contexts[0]).canonical,
      );
    });
  });

  it("fails an over-budget context before prepared-object insertion or provider dispatch", async () => {
    let providerCalls = 0;
    let objectWrites = 0;
    const objects = createMemoryExecutionStore();
    const observedObjects: ExecutionStore = {
      ...objects,
      *putObject(object) {
        objectWrites += 1;
        return yield* objects.putObject(object);
      },
    };
    const driver: ModelProviderDriver = {
      *stream() {
        providerCalls += 1;
        return completedResponse();
      },
      *sample() {
        throw new Error("stream seam only");
      },
    };
    const tinyModel: Model = { ...model, contextWindow: 1 };
    const oversized: ModelSampleRequest = {
      ...request,
      invocation: {
        context: {
          messages: [{ role: "user", content: "x".repeat(70 * 1024) }],
          tools: [],
        },
      },
    };

    await expect(
      run(function* () {
        yield* installExecutionStore(observedObjects);
        yield* installModelProvider(driver);
        const state: { preparation: ModelContextPreparedFact | null } = { preparation: null };
        const service = createHostModelSamplingService({
          model: tinyModel,
          journal: journalAuthority(state),
          conversationStore: conversationStore(),
          conversationId: "conversation-1",
          emitLiveEvents: false,
        });
        yield* service.sample(oversized, attempt);
      }),
    ).rejects.toMatchObject({ code: "model_context_limit_exceeded" });
    expect(objectWrites).toBe(0);
    expect(providerCalls).toBe(0);
  });
});

describe("ProgramDriver model-context composition", () => {
  it("stores embedded context before the journal boundary and preserves staged input", async () => {
    const store = createMemoryExecutionStore();
    const evidence = await run(function* () {
      yield* installExecutionStore(store);
      const staged = yield* stageProgramDriverModelSampleInput(
        request as unknown as Json,
        "conversation-1",
      );
      const decoded = decodeModelSampleSourceRequest(staged);
      const resolved = yield* resolveModelContextSource(decoded.invocation.context);
      const repeated = yield* stageProgramDriverModelSampleInput(staged, "conversation-1");
      return { staged, resolved, repeated };
    });

    expect(evidence.resolved).toEqual(request.invocation.context);
    expect(evidence.repeated).toEqual(evidence.staged);
    expect(JSON.stringify(evidence.staged)).not.toContain('"messages"');
  });
});

describe("host sampling service modes", () => {
  it("refuses journal-backed construction without the conversation store", () => {
    expect(() =>
      createHostModelSamplingService({
        model,
        journal: journalAuthority({ preparation: null }),
      }),
    ).toThrowError(/conversation store/);
  });

  it("streams parked pulls with no journal, preparation, or object traffic", async () => {
    let providerCalls = 0;
    const driver: ModelProviderDriver = {
      *stream() {
        providerCalls += 1;
        return completedResponse();
      },
      *sample() {
        throw new Error("stream seam only");
      },
    };
    const store = createMemoryExecutionStore();
    let objectWrites = 0;
    const originalPut = store.putObject.bind(store);
    store.putObject = function* (request_: Parameters<typeof originalPut>[0]) {
      objectWrites += 1;
      return yield* originalPut(request_);
    } as typeof store.putObject;

    await run(function* () {
      yield* installExecutionStore(store);
      yield* installModelProvider(driver);
      // Pull-fence mode: no journal means no effect-owner preparation protocol.
      const service = createHostModelSamplingService({ model, emitLiveEvents: false });
      const disposition = yield* service.sample(request, attempt);
      expect(disposition.status).toBe("ok");
    });

    expect(providerCalls).toBe(1);
    expect(objectWrites).toBe(0);
  });
});
