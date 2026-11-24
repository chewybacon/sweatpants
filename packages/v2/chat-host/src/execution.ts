import type { CapabilityRequest, EffectDefinition } from "@sweatpan.ts/core";
import type { Acceptance } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  installGuestRetention,
  joinChildHostingResults,
} from "@sweatpan.ts/hosting";
import { createPullStream, type Runtime, type Subscription } from "@sweatpan.ts/runtime";
import { createToolInteractionStream, type ToolInteraction } from "@sweatpan.ts/tools";
import { admitCall, createRejectionBinding } from "./batch-admission.ts";
import type { ChatExecution, ChatExecutionOptions, ChatToolBinding } from "./contracts.ts";

/** Validation failed before this invocation submitted to journal answer ingress.
 * Does not prove that another invocation has never accepted the same grant. */
export class ChatAnswerValidationError extends Error {}

/** Bind execution, ingress and discovery to one open root and compatible catalog.
 * Pure construction; each run owns fresh Hosts and installed policies in a child
 * native scope. No Guest work occurs during answer or discovery. Rebuild after reopen.
 * Program IDs and catalog semantics must remain immutable for persisted executions. */
export function createChatExecution<R, D extends Record<string, EffectDefinition>, Y>(
  runtime: Runtime<Y>,
  options: ChatExecutionOptions<R, D, Y>,
): ChatExecution<R, Y> {
  const { journal } = options;
  const names = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  const programs = new Map(options.tools.map((tool) => [tool.program, tool]));
  if (
    names.size !== options.tools.length ||
    programs.size !== options.tools.length ||
    options.tools.some((tool) => !tool.definition.name.trim() || tool.contract.id !== tool.program)
  ) {
    throw new Error("Chat catalog requires unique names and compatible programs");
  }
  if (!Object.values(options.effects).some((effect) => effect.id === options.batch.effect)) {
    throw new Error("Chat batch effect is not granted");
  }
  const contracts = new Map(options.tools.map((tool) => [tool.program, tool.contract]));
  const reject = options.batch.rejectToolCall;
  const fallback = reject
    ? createRejectionBinding(runtime, options.program, options.recovery, options.matches)
    : undefined;
  if (fallback) {
    if (programs.has(fallback.program)) {
      throw new Error("Chat rejection program conflicts with tool catalog");
    }
    contracts.set(fallback.program, fallback.contract);
  }
  function* verifyProgram() {
    const snapshot = yield* journal.read();
    if (snapshot.program !== options.program) {
      throw new Error("Chat execution program mismatch");
    }
  }
  return {
    id: journal.id,
    run() {
      return runtime.composition.scoped(function* () {
        yield* verifyProgram();
        const effects = createEffectCapabilities(runtime, options.name);
        const grant = effects.grant(options.effects);
        const recovery = options.recovery<R>({
          name: `${options.name}:recovery`,
          program: options.program,
          matches: options.matches,
          acquire: () =>
            options.acquire(
              grant,
              options.tools.map((tool) => structuredClone(tool.definition)),
            ),
        });
        const host = createHosting(runtime.composition, {
          name: `${options.name}:host`,
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          handle: grant.handle,
        });
        yield* installGuestRetention(runtime.composition, host, recovery, journal);
        yield* host.around(grant.admission);
        yield* host.around(
          {
            *child([pending], next) {
              if (pending.request.effect !== options.batch.effect) {
                return yield* next(pending);
              }
              const calls = options.batch.calls(pending.request.input);
              if (!calls.length) {
                throw new Error("Empty chat tool batch");
              }
              if (!reject && calls.some((call) => !names.has(call.name))) {
                throw new Error("Unknown model tool");
              }
              const state = yield* journal.read();
              if (state.status !== "running" || state.pending?.id !== pending.id) {
                throw new Error("Chat batch boundary changed");
              }
              const stored = state.children;
              if (stored && stored.length !== calls.length) {
                throw new Error("Stored chat batch differs from catalog");
              }
              const routes: { binding: ChatToolBinding<Y>; input: unknown }[] = [];
              for (const [index, call] of calls.entries()) {
                routes.push(
                  yield* admitCall(
                    runtime,
                    call,
                    names.get(call.name),
                    stored?.[index],
                    fallback,
                    reject,
                  ),
                );
              }
              const children = yield* journal.ensureChildren<
                unknown,
                CapabilityRequest,
                unknown,
                string
              >(pending.id, {
                children: routes.map(({ binding, input }) => ({
                  program: binding.program,
                  input,
                })),
                outcome: options.batch.outcome,
              });
              return {
                id: pending.id,
                *run() {
                  return joinChildHostingResults(
                    yield* runtime.all(
                      children.map((child, index) => () => routes[index]!.binding.run(child)),
                    ),
                  );
                },
              };
            },
          },
          { at: "min" },
        );
        if (options.configure) {
          yield* options.configure({ host, effects });
        }
        return yield* host.operations.run();
      });
    },
    *answer(target, outcome) {
      yield* verifyProgram();
      const child = yield* journal.openDescendantInteractions(target.execution);
      const tool = programs.get(child.link.program);
      if (!tool) {
        throw new Error("Unknown interaction program");
      }
      const request = yield* child.journal.interactions.request(target.grant);
      if (
        !request ||
        typeof request !== "object" ||
        !("effect" in request) ||
        typeof request.effect !== "string" ||
        !("input" in request)
      ) {
        throw new Error("Malformed authored interaction request");
      }
      const effects = createEffectCapabilities(runtime, `${options.name}:answer`);
      const grant = effects.grant(tool.elicits);
      const prepared = yield* runtime.composition.catchError(
        () => grant.respond(request as CapabilityRequest, outcome),
        function* (error) {
          throw new ChatAnswerValidationError(String(error), { cause: error });
        },
      );
      return (yield* child.journal.interactions.answer(target.grant, {
        ok: true,
        value: prepared,
      })) as Acceptance<CapabilityRequest, unknown, string>;
    },
    interactions() {
      return createPullStream<ToolInteraction, void, Y, Y>(runtime.composition, () => {
        let subscription: Subscription<ToolInteraction, void, Y> | undefined;
        return function* () {
          if (!subscription) {
            yield* verifyProgram();
            subscription = yield* createToolInteractionStream(
              runtime.composition,
              journal,
              contracts,
            );
          }
          return yield* subscription.next();
        };
      });
    },
  };
}
