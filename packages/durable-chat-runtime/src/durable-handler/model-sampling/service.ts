import { EventType } from "@ag-ui/core";
import { call, race, type Operation } from "effection";
import {
  assertJson,
  replaceControlCharacters,
  stableTupleHash,
  type Json,
  canonicalDigest,
  cloneJson,
} from "@sweatpants/foundation";
import { CrankError } from "@sweatpants/durable-execution";
import {
  decodeModelContext,
  ModelProviderApi,
  UnsupportedModelCapabilityError,
  type Model,
  type ModelContext,
  type StreamOptions,
} from "@sweatpants/model-provider";
import {
  decodeModelSampleRequest,
  decodeModelSampleResult,
  decodeModelSampleSourceRequest,
  encodeModelSampleSourceRequest,
  settleModelSample,
  type ModelContextSource,
  type ModelSampleSourceRequest,
  type ModelSamplingService,
} from "@sweatpants/model-sampling";
import {
  agUiMessagesToChatHistoryEntries,
  decodePublicProjectionRoot,
  type HistoryPolicy,
  type PublicProjectionRoot,
} from "@sweatpants/chat-core";
import { createContentAddressedExecutionObject } from "@sweatpants/journal-authority/store-persistence";
import { ExecutionStoreApi } from "@sweatpants/journal-authority/api";
import { useConversationStore } from "@sweatpants/history-store/port";
import type {
  DurableSemanticRecord,
  ModelContextPolicyDecision,
  ModelContextPreparedFact,
} from "@sweatpants/journal-authority";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import type { ProgramDriverJournal } from "../program-driver-journal.ts";
import { useLogger } from "../../logger/index.ts";
import type { ChatToolCatalog } from "../program-driver-schema.ts";
import { planModelInvocation, type ModelInvocationDecision } from "./plan.ts";
import { readAllPublicRootsForModel } from "../../conversation-persistence.ts";
import { projectChatHistory } from "./history.ts";
import { TurnEventApi } from "./turn-event-api.ts";

const MAX_PARTIAL_TEXT_LENGTH = 32_768;
const MAX_PREPARED_CONTEXT_BYTES = 64 * 1024 * 1024;

interface PreparedModelInvocation {
  readonly version: 1;
  readonly model: { readonly provider: string; readonly id: string };
  readonly context: ModelContext;
  readonly options: Json;
  readonly response: Json;
  readonly delivery: Json;
  readonly decisions: Json;
}

function contextPolicyDecisions(
  decisions: readonly ModelInvocationDecision[],
): readonly ModelContextPolicyDecision[] {
  return decisions.flatMap((decision) =>
    decision.type === "history-policy"
      ? decision.decisions.map((historyDecision) => ({
          type: "history-policy" as const,
          policyId: decision.policy,
          action: historyDecision.action,
          reason: historyDecision.reason,
          roles: historyDecision.roles,
          toolCallIds: historyDecision.toolCallIds,
        }))
      : [],
  );
}

export function preparedModelContextByteLimit(contextWindow: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new CrankError(
      "model_context_limit_exceeded",
      "Model context window must be a positive finite integer",
    );
  }
  return Math.min(MAX_PREPARED_CONTEXT_BYTES, contextWindow * 8);
}

function semanticOptions(value: Record<string, unknown>): Json {
  const { signal: _signal, apiKey: _apiKey, env: _env, ...semantic } = value;
  return cloneJson(semantic as Json);
}

function decodePreparedInvocation(value: unknown): PreparedModelInvocation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CrankError("model_context_source_invalid", "Prepared model context is invalid");
  }
  const input = value as Record<string, unknown>;
  const expected = new Set([
    "version",
    "model",
    "context",
    "options",
    "response",
    "delivery",
    "decisions",
  ]);
  if (
    input["version"] !== 1 ||
    Object.keys(input).length !== expected.size ||
    Object.keys(input).some((key) => !expected.has(key))
  ) {
    throw new CrankError("model_context_source_invalid", "Prepared model context shape is invalid");
  }
  const model = input["model"];
  if (model === null || typeof model !== "object" || Array.isArray(model)) {
    throw new CrankError("model_context_source_invalid", "Prepared model identity is invalid");
  }
  const modelRecord = model as Record<string, unknown>;
  if (typeof modelRecord["provider"] !== "string" || typeof modelRecord["id"] !== "string") {
    throw new CrankError("model_context_source_invalid", "Prepared model identity is invalid");
  }
  return {
    version: 1,
    model: { provider: modelRecord["provider"], id: modelRecord["id"] },
    context: decodeModelContext(input["context"]),
    options: cloneJson(input["options"] as Json),
    response: cloneJson(input["response"] as Json),
    delivery: cloneJson(input["delivery"] as Json),
    decisions: cloneJson(input["decisions"] as Json),
  };
}

function* loadPreparedInvocation(
  fact: ModelContextPreparedFact,
  model: Model,
): Operation<PreparedModelInvocation> {
  const stored = yield* ExecutionStoreApi.operations.getObject(fact.contextObject);
  if (!stored || stored.contentHash !== fact.invocationDigest) {
    throw new CrankError(
      "model_context_source_invalid",
      "Accepted prepared model context object is missing or corrupt",
    );
  }
  const prepared = decodePreparedInvocation(stored.body);
  if (
    prepared.model.provider !== fact.model.provider ||
    prepared.model.id !== fact.model.id ||
    prepared.model.provider !== model.provider ||
    prepared.model.id !== model.id ||
    canonicalDigest(prepared.context) !== fact.contextDigest ||
    canonicalDigest(prepared) !== fact.invocationDigest
  ) {
    throw new CrankError(
      "model_context_identity_conflict",
      "Accepted model preparation differs from the current provider identity",
    );
  }
  return prepared;
}

export function* stageModelContextSource(
  value: ModelContext,
  conversationId: string,
): Operation<ModelContextSource> {
  const prepared = yield* call(() =>
    createContentAddressedExecutionObject(
      {
        lifetimeScope: "conversation",
        scopeOwnerId: conversationId,
        objectKind: "model-context-source.v1",
        createdAt: Date.now(),
      },
      ["model-context-source", conversationId],
      value,
    ),
  );
  const contextDigest = prepared.contentHash;
  const object = yield* ExecutionStoreApi.operations.putObject(prepared);
  return { type: "object", object, digest: contextDigest };
}

/**
 * Explicit ProgramDriver transport composition edge. Process-independent
 * evaluators cannot inherit the Host's context stager; this stores an embedded
 * context before Authority receives the descriptor. Already-staged source
 * requests pass through unchanged.
 */
export function* stageProgramDriverModelSampleInput(
  input: Json,
  conversationId: string,
): Operation<Json> {
  const rawInvocation =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? input["invocation"]
      : undefined;
  const rawContext =
    rawInvocation !== null && typeof rawInvocation === "object" && !Array.isArray(rawInvocation)
      ? rawInvocation["context"]
      : undefined;
  if (
    rawContext !== null &&
    typeof rawContext === "object" &&
    !Array.isArray(rawContext) &&
    (rawContext["type"] === "conversation" || rawContext["type"] === "object")
  ) {
    return encodeModelSampleSourceRequest(decodeModelSampleSourceRequest(input));
  }
  const request = decodeModelSampleRequest(input);
  const sourceRequest: ModelSampleSourceRequest = {
    ...request,
    invocation: {
      context: yield* stageModelContextSource(request.invocation.context, conversationId),
      /* CONDITIONAL-SPREAD: Omit absent options from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(request.invocation.options === undefined ? {} : { options: request.invocation.options }),
    },
  };
  return encodeModelSampleSourceRequest(sourceRequest);
}

function modelContextMessagesFromRoots(roots: readonly Json[]): ModelContext["messages"] {
  const messages = roots
    .map((root) => decodePublicProjectionRoot(root))
    .filter(
      (root): root is Extract<PublicProjectionRoot, { kind: "message" }> => root.kind === "message",
    )
    .sort((left, right) => {
      const a = BigInt(left.position);
      const b = BigInt(right.position);
      return a === b ? 0 : a < b ? -1 : 1;
    })
    .map((root) => root.message);
  // Public roots retain child execution for the UI. It is not conversation-model history.
  // Tool results inherit ownership from their opener, even without their own owner tag.
  const childCallIds = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" && message.subagentRunId !== undefined
        ? (message.toolCalls ?? []).map((call) => call.id)
        : [],
    ),
  );
  const outerMessages = messages.filter(
    (message) =>
      message.subagentRunId === undefined &&
      (message.role !== "tool" || !childCallIds.has(message.toolCallId)),
  );
  return projectChatHistory(agUiMessagesToChatHistoryEntries(outerMessages));
}

function taskModelMessages(records: readonly DurableSemanticRecord[]): ModelContext["messages"] {
  const pulls = new Map(
    records.flatMap((record) =>
      record.payload.type === "PullRequested"
        ? [[record.payload.pullId, record.payload] as const]
        : [],
    ),
  );
  const messages: Array<ModelContext["messages"][number]> = [];
  for (const record of records) {
    if (record.payload.type === "PullResolved") {
      const request = pulls.get(record.payload.pullId);
      if (request?.descriptor.kind === "sample" && record.payload.outcome.status === "ok") {
        const result = decodeModelSampleResult(record.payload.outcome.value);
        messages.push(result.message.message);
      }
      continue;
    }
    if (record.payload.type !== "DurableEmission") {
      continue;
    }
    if (record.payload.descriptor.eventType !== "tool_completed") {
      continue;
    }
    const payload =
      record.payload.descriptor.payload !== null &&
      typeof record.payload.descriptor.payload === "object" &&
      !Array.isArray(record.payload.descriptor.payload)
        ? record.payload.descriptor.payload
        : null;
    if (!payload || typeof payload["callId"] !== "string" || typeof payload["tool"] !== "string") {
      continue;
    }
    messages.push({
      role: "tool",
      toolCallId: payload["callId"],
      name: payload["tool"],
      content: JSON.stringify(payload["result"] ?? null),
      isError: payload["failed"] === true,
    });
  }
  return messages;
}

export function* resolveModelContextSource(
  source: ModelContextSource,
  options: {
    readonly journal?: ProgramDriverJournal;
    readonly maxCanonicalBytes?: number;
  } = {},
): Operation<ModelContext> {
  if (source.type === "conversation") {
    const conversationStore = yield* useConversationStore();
    if (source.contextArtifact) {
      throw new CrankError(
        "model_context_source_invalid",
        "Conversation context artifacts require an explicit coverage planner",
      );
    }
    const head = yield* conversationStore.loadHead(source.conversationId);
    if (!head || head.activeExecutionId !== source.executionId) {
      throw new CrankError(
        "model_context_source_invalid",
        "Conversation context source no longer matches the authoritative head",
      );
    }
    const activeCommand =
      head.activeCommand &&
      typeof head.activeCommand === "object" &&
      !Array.isArray(head.activeCommand)
        ? head.activeCommand
        : null;
    if (!activeCommand || typeof activeCommand["commandId"] !== "string") {
      throw new CrankError(
        "model_context_source_invalid",
        "Conversation context source has no active command",
      );
    }
    const checkpoint = yield* conversationStore.getCheckpoint(source.checkpoint);
    if (!checkpoint) {
      throw new CrankError(
        "model_context_source_invalid",
        "Conversation context checkpoint is missing",
      );
    }
    const roots = yield* readAllPublicRootsForModel(
      source.conversationId,
      checkpoint,
      options.maxCanonicalBytes ?? MAX_PREPARED_CONTEXT_BYTES,
    );
    const taskRecords = options.journal
      ? yield* options.journal.readJournal(source.conversationId, source.taskId)
      : [];
    const rootTaskRecords = taskRecords.filter((record) => record.payload.taskId === source.taskId);

    return {
      messages: [
        ...(source.systemPrompt ? [{ role: "system" as const, content: source.systemPrompt }] : []),
        ...modelContextMessagesFromRoots(roots),
        ...taskModelMessages(rootTaskRecords),
      ],
      tools: [],
    };
  }
  const stored = yield* ExecutionStoreApi.operations.getObject(source.object);
  if (
    !stored ||
    stored.objectKind !== "model-context-source.v1" ||
    stored.contentHash !== source.digest
  ) {
    throw new CrankError(
      "model_context_source_invalid",
      "Model context source object is missing or corrupt",
    );
  }
  const context = decodeModelContext(stored.body);
  if (canonicalDigest(context) !== source.digest) {
    throw new CrankError("model_context_source_invalid", "Model context source digest differs");
  }
  return context;
}

export function safeProviderErrorMessage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return replaceControlCharacters(value)
    .replaceAll(/(bearer|basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replaceAll(/(token|api[-_ ]?key)\s*[:=]?\s*[^\s,;]+/gi, "$1 [redacted]")
    .replaceAll(/\bsk-[A-Za-z0-9][^\s,;]*/g, "[redacted]")
    .trim()
    .slice(0, 512);
}

export function createHostModelSamplingService(options: {
  model: Model;
  streamOptions?: StreamOptions;
  catalog?: ChatToolCatalog;
  historyPolicy?: HistoryPolicy;
  /**
   * Presence selects the sampling mode. With the journal, samples run the
   * effect-owner preparation protocol (stage → accept → authorize) and
   * require `conversationStore` + `conversationId`. Without it, pulls are
   * fenced by their pull capability alone and stream without preparation —
   * there is no AttemptStarted owner to fence with.
   */
  journal?: ProgramDriverJournal;
  conversationStore?: ConversationStore;
  conversationId?: string;
  /** Execution-owned samples must use a relay, not the Host Turn event writer. */
  emitLiveEvents?: boolean;
  onLiveMessageStarted?: (messageId: string) => void;
  onLiveMessageEnded?: (messageId: string) => void;
}): ModelSamplingService {
  if (options.journal && !(options.conversationStore && options.conversationId)) {
    // Silent degradation here would quietly disable durable preparation
    // (retry-safe dispatch fences) for every sample on this service.
    throw new CrankError(
      "model_context_source_invalid",
      "Journal-backed model sampling requires the conversation store and id",
    );
  }
  return {
    // Provider streaming intentionally keeps plan, delivery, settlement, and cancellation in one pump.
    // fallow-ignore-next-line complexity
    *sample(request, attempt) {
      let plan = planModelInvocation({
        request,
        attempt,
        model: options.model,
        streamOptions: options.streamOptions,
        catalog: options.catalog,
        historyPolicy: options.historyPolicy,
      });
      const existingPreparation = options.journal
        ? yield* options.journal.pullPreparation(attempt.sessionId, attempt.taskId, attempt.pullId)
        : null;
      let acceptedPreparation = existingPreparation;
      if (existingPreparation) {
        const prepared = yield* loadPreparedInvocation(existingPreparation, options.model);
        plan = {
          ...plan,
          providerRequest: {
            model: options.model,
            context: prepared.context,
            options: {
              ...(prepared.options as Record<string, unknown>),
              apiKey: plan.providerRequest.options?.apiKey,
              env: plan.providerRequest.options?.env,
              signal: attempt.cancellation,
              sessionId: attempt.pullId,
            },
          },
          /* CONDITIONAL-SPREAD: The delivery fields belong only to the plan.delivery.type === "outer-assistant" variant. */
          ...(plan.delivery.type === "outer-assistant"
            ? {
                delivery: {
                  ...plan.delivery,
                  messageId: existingPreparation.publicMessageId,
                },
              }
            : {}),
        };
      } else if (options.journal && options.conversationStore && options.conversationId) {
        // The constructor guard guarantees this triple is all-or-nothing.
        const contextDigest = canonicalDigest(plan.providerRequest.context);
        const prepared: PreparedModelInvocation = structuredClone({
          version: 1,
          model: { provider: options.model.provider, id: options.model.id },
          context: plan.providerRequest.context,
          options: semanticOptions(plan.providerRequest.options as Record<string, unknown>),
          response: assertJson(plan.response),
          delivery: assertJson(plan.delivery),
          decisions: assertJson(plan.decisions),
        });
        const maxCanonicalBytes = preparedModelContextByteLimit(options.model.contextWindow);
        const head = yield* options.conversationStore.loadHead(options.conversationId);
        if (!head?.checkpoint || !head.activeExecutionId || !head.activeCommand) {
          throw new CrankError(
            "model_context_source_invalid",
            "Model preparation requires an admitted command checkpoint",
          );
        }
        const checkpoint = yield* options.conversationStore.getCheckpoint(head.checkpoint);
        const activeCommand =
          head.activeCommand !== null &&
          typeof head.activeCommand === "object" &&
          !Array.isArray(head.activeCommand)
            ? head.activeCommand
            : null;
        const acceptedCommandId = activeCommand?.["commandId"];
        if (!checkpoint || typeof acceptedCommandId !== "string") {
          throw new CrankError(
            "model_context_source_invalid",
            "Model preparation source checkpoint or command is missing",
          );
        }
        const publicMessageId = stableTupleHash(["sweatpants.public-assistant", attempt.pullId]);
        const object = yield* call(() =>
          createContentAddressedExecutionObject(
            {
              lifetimeScope: "execution",
              scopeOwnerId: head.activeExecutionId!,
              objectKind: "prepared-model-context.v1",
              createdAt: Date.now(),
            },
            ["prepared-model-context", head.activeExecutionId!, attempt.taskId, attempt.pullId],
            prepared,
          ),
        );
        const { contentHash: invocationDigest, byteLength } = object;
        if (byteLength > maxCanonicalBytes) {
          throw new CrankError(
            "model_context_limit_exceeded",
            `Prepared model context ${byteLength} exceeds budget ${maxCanonicalBytes}`,
          );
        }
        const contextObject = yield* ExecutionStoreApi.operations.putObject(object);
        const budget = {
          id: `provider:${options.model.provider}/${options.model.id}:context-window`,
          maxCanonicalBytes,
          contextWindow: options.model.contextWindow,
        };
        const fact: ModelContextPreparedFact = {
          type: "ModelContextPrepared",
          executionId: head.activeExecutionId,
          taskId: attempt.taskId,
          pullId: attempt.pullId,
          contextObject,
          contextDigest,
          invocationDigest,
          responseModeDigest: canonicalDigest(assertJson(plan.response)),
          generationOptionsDigest: canonicalDigest(prepared.options),
          sourceCheckpoint: head.checkpoint,
          sourceArchiveHeadSegmentId: checkpoint.archiveHead?.segmentId ?? null,
          sourceArchiveFrontierOrdinal: checkpoint.archiveFrontierOrdinal,
          sourceNextPublicPosition: checkpoint.nextPublicPosition,
          acceptedCommandId,
          policyId: options.historyPolicy?.name ?? "complete-causal-history",
          policyDecisions: contextPolicyDecisions(plan.decisions),
          budgetId: budget.id,
          budgetDigest: canonicalDigest(budget),
          toolCatalogDigest:
            options.catalog?.digest ?? stableTupleHash(["model-tools", request.tools]),
          model: { provider: options.model.provider, id: options.model.id },
          publicMessageId,
        };
        const accepted = yield* options.journal.acceptPullPreparation({
          executionId: head.activeExecutionId,
          taskId: attempt.taskId,
          pullId: attempt.pullId,
          expectedOwnerFence: attempt.attemptId,
          kind: "model-context",
          fact,
        });
        if (accepted.status === "stale_owner" || accepted.status === "pull_not_pending") {
          throw new CrankError(
            "model_context_source_invalid",
            "Model pull settled before preparation",
          );
        }
        if (accepted.status === "identity_conflict") {
          throw new CrankError(
            "model_context_identity_conflict",
            "Model pull already has another preparation identity",
          );
        }
        if (accepted.status === "duplicate") {
          const authorized = yield* options.journal.authorizeModelDispatch({
            executionId: fact.executionId,
            taskId: fact.taskId,
            pullId: fact.pullId,
            expectedOwnerFence: attempt.attemptId,
            invocationDigest: fact.invocationDigest,
          });
          if (authorized.status !== "authorized") {
            throw new CrankError(
              authorized.status === "stale_owner"
                ? "model_context_source_invalid"
                : "model_context_identity_conflict",
              "Accepted model preparation could not be reloaded for retry",
            );
          }
          acceptedPreparation = authorized.fact;
          const prepared = yield* loadPreparedInvocation(authorized.fact, options.model);
          plan = {
            ...plan,
            providerRequest: {
              model: options.model,
              context: prepared.context,
              options: {
                ...(prepared.options as Record<string, unknown>),
                apiKey: plan.providerRequest.options?.apiKey,
                env: plan.providerRequest.options?.env,
                signal: attempt.cancellation,
                sessionId: attempt.pullId,
              },
            },
            /* CONDITIONAL-SPREAD: The delivery fields belong only to the plan.delivery.type === "outer-assistant" variant. */
            ...(plan.delivery.type === "outer-assistant"
              ? {
                  delivery: {
                    ...plan.delivery,
                    messageId: authorized.fact.publicMessageId,
                  },
                }
              : {}),
          };
        } else {
          acceptedPreparation = fact;
        }
        if (plan.delivery.type === "outer-assistant" && acceptedPreparation) {
          plan = {
            ...plan,
            delivery: { ...plan.delivery, messageId: acceptedPreparation.publicMessageId },
          };
        }
      }
      const log = yield* useLogger("handler:durable:model-sample");
      log.debug(
        {
          pullId: attempt.pullId,
          caller: plan.caller.type,
          decisions: plan.decisions,
        },
        "sampling model through planned provider invocation",
      );

      const deliverOuter =
        options.emitLiveEvents !== false &&
        plan.delivery.type === "outer-assistant" &&
        (yield* TurnEventApi.operations.installed());
      let partialText = "";
      let streamStarted = false;
      const acceptPartial = function* (
        disposition: "interrupted" | "provider-error",
      ): Operation<void> {
        if (
          !options.journal ||
          (!acceptedPreparation && !(options.conversationStore && options.conversationId)) ||
          plan.delivery.type !== "outer-assistant" ||
          partialText.length === 0
        ) {
          return;
        }
        const preparation =
          acceptedPreparation ??
          (yield* options.journal.pullPreparation(
            attempt.sessionId,
            attempt.taskId,
            attempt.pullId,
          ));
        if (!preparation) {
          return;
        }
        const accepted = yield* options.journal.acceptAssistantPartial({
          executionId: preparation.executionId,
          taskId: attempt.taskId,
          pullId: attempt.pullId,
          expectedOwnerFence: attempt.attemptId,
          fact: {
            type: "AssistantPartialAccepted",
            messageId: preparation.publicMessageId,
            text: partialText,
            disposition,
          },
        });
        if (accepted.status === "stale_owner" || accepted.status === "pull_not_pending") {
          throw new CrankError(
            "model_context_source_invalid",
            "Model pull settled before assistant partial acceptance",
          );
        }
        if (accepted.status === "identity_conflict") {
          throw new CrankError(
            "model_context_identity_conflict",
            "Model pull already has another assistant partial",
          );
        }
      };
      return yield* race([
        (function* (): Operation<
          | { status: "ok"; value: ReturnType<typeof settleModelSample> }
          | { status: "cancelled"; partial: { text: string; interrupted: true } }
        > {
          try {
            if (options.journal && acceptedPreparation) {
              const authorized = yield* options.journal.authorizeModelDispatch({
                executionId: acceptedPreparation.executionId,
                taskId: attempt.taskId,
                pullId: attempt.pullId,
                expectedOwnerFence: attempt.attemptId,
                invocationDigest: acceptedPreparation.invocationDigest,
              });
              if (authorized.status !== "authorized") {
                throw new CrankError(
                  authorized.status === "stale_owner"
                    ? "model_context_source_invalid"
                    : "model_context_identity_conflict",
                  "Model dispatch lost its accepted preparation fence",
                );
              }
              acceptedPreparation = authorized.fact;
            }
            const stream = yield* ModelProviderApi.operations.stream(plan.providerRequest);
            const subscription = yield* stream;
            while (true) {
              const next = yield* subscription.next();
              if (next.done) {
                const result = settleModelSample(plan.response, next.value);
                if (streamStarted && plan.delivery.type === "outer-assistant") {
                  yield* TurnEventApi.operations.emit({
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: plan.delivery.messageId,
                  });
                  options.onLiveMessageEnded?.(plan.delivery.messageId);
                }
                return { status: "ok", value: result };
              }
              if (next.value.type === "text-delta") {
                if (partialText.length < MAX_PARTIAL_TEXT_LENGTH) {
                  partialText += next.value.delta.slice(
                    0,
                    MAX_PARTIAL_TEXT_LENGTH - partialText.length,
                  );
                }
                if (plan.delivery.type === "outer-assistant" && deliverOuter) {
                  if (!streamStarted) {
                    streamStarted = true;
                    options.onLiveMessageStarted?.(plan.delivery.messageId);
                    yield* TurnEventApi.operations.emit({
                      type: EventType.TEXT_MESSAGE_START,
                      messageId: plan.delivery.messageId,
                      role: "assistant",
                    });
                  }
                  yield* TurnEventApi.operations.emit({
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: plan.delivery.messageId,
                    delta: next.value.delta,
                  });
                }
              }
              if (next.value.type === "error") {
                throw new CrankError("model_runtime_failed", "Model runtime failed");
              }
            }
          } catch (error) {
            if (attempt.cancellation.aborted) {
              yield* acceptPartial("interrupted");
              return {
                status: "cancelled",
                partial: { text: partialText, interrupted: true },
              };
            }
            yield* acceptPartial("provider-error");
            if (error instanceof CrankError) {
              throw new CrankError(error.code, error.message, undefined, {
                cause: error,
              });
            }
            if (error instanceof UnsupportedModelCapabilityError) {
              throw new CrankError("unsupported_model_capability", error.message, undefined, {
                cause: error,
              });
            }
            throw new CrankError("model_runtime_failed", "Provider error", undefined, {
              cause: error,
            });
          }
        })(),
        (function* (): Operation<{
          status: "cancelled";
          partial: { text: string; interrupted: true };
        }> {
          if (!attempt.cancellation.aborted) {
            yield* call(
              () =>
                new Promise<void>((resolve) => {
                  attempt.cancellation.addEventListener("abort", () => resolve(), { once: true });
                }),
            );
          }
          yield* acceptPartial("interrupted");
          return {
            status: "cancelled",
            partial: { text: partialText, interrupted: true },
          };
        })(),
      ]);
    },
  };
}
