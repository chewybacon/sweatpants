import { defineEffect } from "@sweatpan.ts/core";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { runChat, type ChatHistoryMessage, type ChatLoopRequest } from "@sweatpan.ts/chat";
import { createChatExecution } from "./execution.ts";
import { createHistoryFingerprint, createRecordedHistory } from "./history.ts";
import {
  decodeRecordedChatCalls,
  decodeRecordedChatRequest,
  decodeRecordedChatSampleOutcome,
  recordedChatRequestSchema,
  recordedChatSampleSchema,
  recordedChatCallsSchema,
  recordedChatValuesSchema,
  recordedChatFailureMessage,
} from "./protocol.ts";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Operation } from "@standard-durability/core";
import type {
  ChatProgram,
  ChatProgramOptions,
  ChatProgramBinding,
  RecordedChatExecution,
  RecordedChatRecord,
} from "./contracts.ts";
import type { RecordedChatRequest } from "./types.ts";

/** Declare the recorded-chat/v2 protocol once, without runtime state or installations.
 * Owns sampling/batch effect identity, transport Outcome wrapping and call correlation.
 * Uses the existing streamChat implementation through runChat; records no separate
 * progress effects. Never reinterpret older custom programs under the generated ID.
 * Projections and their captured dependencies must remain pure and replay-stable. */
export function defineChatProgram<R>(options: ChatProgramOptions<R>): ChatProgram<R> {
  if (!options.id.trim()) {
    throw new Error("Empty chat program ID");
  }
  const id = `${options.id}/recorded-chat/v2`;
  const { history, toolResult, rejectToolCall, result } = options;
  const sample = defineEffect({
    key: `${id}/sample`,
    context: recordedChatRequestSchema,
    response: recordedChatSampleSchema,
  });
  const batch = defineEffect({
    key: `${id}/tools`,
    context: recordedChatCallsSchema,
    response: recordedChatValuesSchema,
  });
  function decode(entry: {
    readonly request: unknown;
    readonly outcome?: unknown;
  }): RecordedChatRecord | undefined {
    const request = entry.request as { readonly effect?: unknown; readonly input?: unknown } | null;
    if (request?.effect === sample.id) {
      const round = decodeRecordedChatRequest(request.input).round;
      if (!("outcome" in entry) || entry.outcome === undefined) {
        return { kind: "sample", round, state: "pending" };
      }
      const value = decodeRecordedChatSampleOutcome(entry.outcome);
      return value
        ? { kind: "sample", round, state: "accepted", sample: structuredClone(value) }
        : { kind: "sample", round, state: "denied" };
    }
    if (request?.effect === batch.id) {
      return { kind: "tools", calls: structuredClone(decodeRecordedChatCalls(request.input)) };
    }
    return undefined;
  }
  return Object.freeze({
    id,
    decode,
    bind<Y>(runtime: Runtime<Y>, binding: ChatProgramBinding<R, Y>): RecordedChatExecution<R, Y> {
      let initial: readonly ChatHistoryMessage[] | undefined;
      function* initialHistory(input: unknown): Operation<readonly ChatHistoryMessage[], Y> {
        if (!initial) {
          const inherited = binding.historySource ? yield* binding.historySource.read(input) : [];
          initial = structuredClone([...inherited, ...history(input)]);
        }
        return structuredClone(initial);
      }
      const retained = createRecordedHistory({
        journal: binding.journal,
        program: id,
        tools: binding.tools.map((tool) => structuredClone(tool.definition)),
        initialHistory,
        toolResult,
      });
      const execution = createChatExecution(runtime, {
        name: id,
        program: id,
        journal: binding.journal,
        tools: binding.tools,
        descendantInteractionContracts: binding.descendantInteractionContracts,
        recovery: binding.recovery,
        matches: binding.matches,
        effects: { sample, batch },
        batch: {
          effect: batch.id,
          rejectToolCall,
          calls: decodeRecordedChatCalls,
          outcome: (values) => ({ ok: true, value: { ok: true, value: values } }),
        },
        *acquire(grant, definitions) {
          const snapshot = yield* binding.journal.read();
          if (!snapshot.admission) {
            throw new Error("Chat program requires admitted input");
          }
          const initial = yield* initialHistory(snapshot.admission.input);
          return createScopedGuest(function* (scope) {
            const fingerprint = createHistoryFingerprint(definitions);
            let historyLength = 0;
            const completed = yield* runChat(scope, {
              history: initial,
              allowUnknownToolNames: !!rejectToolCall,
              tools: definitions.map((definition) => ({ definition })),
              *sample(request) {
                for (const message of request.history.slice(historyLength)) {
                  fingerprint.append(message);
                }
                historyLength = request.history.length;
                const answer = yield* grant.capabilities.sample({
                  round: request.round,
                  historyLength,
                  historyHash: fingerprint.digest(),
                });
                if (!answer.ok) {
                  throw new Error(recordedChatFailureMessage(answer.error), {
                    cause: answer.error,
                  });
                }
                return answer;
              },
              *executeTools(requested) {
                const answer = yield* grant.capabilities.batch(requested);
                if (!answer.ok) {
                  throw new Error("Chat tool batch failed", { cause: answer.error });
                }
                if (!Array.isArray(answer.value) || answer.value.length !== requested.length) {
                  throw new Error("Chat batch result count differs from calls");
                }
                return requested.map((call, index) => ({
                  ...toolResult(answer.value[index], structuredClone(call)),
                  toolCallId: call.id,
                }));
              },
            });
            return result(completed);
          });
        },
        *configure({ host, effects }) {
          let prepared:
            | { id: string; boundary: RecordedChatRequest; value: ChatLoopRequest }
            | undefined;
          yield* host.around({
            *activate(args, next) {
              const activation = yield* next(...args);
              prepared = undefined;
              if (
                activation.state === "parked" &&
                activation.pending.request.effect === sample.id
              ) {
                const boundary = decodeRecordedChatRequest(activation.pending.request.input);
                const value = yield* retained.read(boundary);
                prepared = { id: activation.pending.id, boundary, value };
              }
              return activation;
            },
          });
          yield* effects.install(sample, function* (request) {
            const grant = yield* host.delivery.expect();
            if (
              !prepared ||
              prepared.id !== grant.requestId ||
              prepared.boundary.round !== request.round ||
              prepared.boundary.historyLength !== request.historyLength ||
              prepared.boundary.historyHash !== request.historyHash
            ) {
              throw new Error("Prepared sampling request differs from the delivery grant");
            }
            const value = prepared.value;
            prepared = undefined;
            return yield* binding.sampling.sample(value);
          });
          if (binding.configure) {
            yield* binding.configure(host);
          }
        },
      });
      return {
        ...execution,
        *history() {
          const snapshot = yield* retained.snapshot();
          return snapshot.history;
        },
        *latestSample() {
          const snapshot = yield* binding.journal.read();
          if (snapshot.program !== id) {
            throw new Error("Recorded chat history requires its admitted program");
          }
          for (let position = snapshot.history.end.position - 1; position >= 0; position--) {
            const entry = yield* snapshot.history.at(position);
            if (!entry || entry.sequence !== position) {
              throw new Error("Invalid accepted history sequence");
            }
            const record = decode(entry);
            if (record?.kind === "sample" && record.sample) {
              return {
                round: record.round,
                sequence: entry.sequence,
                receipt: entry.receipt,
                sample: record.sample,
              };
            }
          }
          return undefined;
        },
      };
    },
  } satisfies ChatProgram<R>);
}
