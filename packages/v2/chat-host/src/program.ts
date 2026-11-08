import type { StandardSchemaV1 } from "@standard-schema/spec";
import { defineEffect } from "@sweatpan.ts/core";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { runChat, type ChatLoopRequest, type ChatLoopSample } from "@sweatpan.ts/chat";
import { createChatExecution } from "./execution.ts";
import type { ChatProgram, ChatProgramOptions } from "./contracts.ts";

// Local domain-envelope checks. Provider-specific message/media decoding remains
// the typed sampling adapter's responsibility, not this recording protocol's codec.
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function schema<T>(valid: (value: unknown) => boolean): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "sweatpan.ts/chat-host",
      validate(value) {
        return valid(value)
          ? { value: value as T }
          : { issues: [{ message: "Invalid recorded chat envelope" }] };
      },
    },
  };
}
const requestSchema = schema<ChatLoopRequest>(
  (value) =>
    record(value) &&
    Number.isSafeInteger(value.round) &&
    Number(value.round) >= 0 &&
    Array.isArray(value.history) &&
    Array.isArray(value.tools),
);
const sampleSchema = schema<ChatLoopSample>(
  (value) =>
    record(value) &&
    record(value.model) &&
    [value.model.provider, value.model.api, value.model.id].every(
      (part) => typeof part === "string" && part.length > 0,
    ) &&
    record(value.response) &&
    record(value.response.message) &&
    value.response.message.role === "assistant" &&
    Array.isArray(value.response.message.content),
);
type Call = { readonly id: string; readonly name: string; readonly input: unknown };
function calls(input: unknown): readonly Call[] {
  if (!Array.isArray(input) || !input.length) {
    throw new Error("Empty or invalid chat batch");
  }
  const seen = new Set<string>();
  return input.map((value: unknown) => {
    if (
      !record(value) ||
      typeof value.id !== "string" ||
      !value.id.trim() ||
      seen.has(value.id) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      !("input" in value)
    ) {
      throw new Error("Invalid or duplicate chat call");
    }
    seen.add(value.id);
    return { id: value.id, name: value.name, input: value.input };
  });
}
const callsSchema: StandardSchemaV1<readonly Call[]> = {
  "~standard": {
    version: 1,
    vendor: "sweatpan.ts/chat-host",
    validate(value) {
      try {
        return { value: calls(value) };
      } catch (error) {
        return { issues: [{ message: String(error) }] };
      }
    },
  },
};

/** Declare the recorded-chat/v1 protocol once, without runtime state or installations.
 * Owns sampling/batch effect identity, transport Outcome wrapping and call correlation.
 * Uses the existing streamChat implementation through runChat; records no separate
 * progress effects. Never reinterpret older custom programs under the generated ID.
 * Projections and their captured dependencies must remain pure and replay-stable. */
export function defineChatProgram<R>(options: ChatProgramOptions<R>): ChatProgram<R> {
  if (!options.id.trim()) {
    throw new Error("Empty chat program ID");
  }
  const id = `${options.id}/recorded-chat/v1`;
  const { history, toolResult, result } = options;
  const sample = defineEffect({
    key: `${id}/sample`,
    context: requestSchema,
    response: sampleSchema,
  });
  const batch = defineEffect({
    key: `${id}/tools`,
    context: callsSchema,
    response: schema<readonly unknown[]>(Array.isArray),
  });
  return Object.freeze({
    id,
    bind(runtime, binding) {
      return createChatExecution(runtime, {
        name: id,
        program: id,
        journal: binding.journal,
        tools: binding.tools,
        recovery: binding.recovery,
        matches: binding.matches,
        effects: { sample, batch },
        batch: {
          effect: batch.id,
          calls,
          outcome: (values) => ({ ok: true, value: { ok: true, value: values } }),
        },
        *acquire(grant, definitions) {
          const snapshot = yield* binding.journal.read();
          if (!snapshot.admission) {
            throw new Error("Chat program requires admitted input");
          }
          const initial = structuredClone([...history(snapshot.admission.input)]);
          return createScopedGuest(function* (scope) {
            const completed = yield* runChat(scope, {
              history: initial,
              tools: definitions.map((definition) => ({ definition })),
              *sample(request) {
                const answer = yield* grant.capabilities.sample(request);
                if (!answer.ok) {
                  const message =
                    record(answer.error) && typeof answer.error.message === "string"
                      ? answer.error.message
                      : "Chat sampling failed";
                  throw new Error(message, { cause: answer.error });
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
          yield* effects.install(sample, (request) => binding.sampling.sample(request));
          if (binding.configure) {
            yield* binding.configure(host);
          }
        },
      });
    },
  } satisfies ChatProgram<R>);
}
