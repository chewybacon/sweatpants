import type { Operation } from "@standard-durability/core";
import type { ModelProvider, ModelResponse, ModelStreamEvent } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { PiAiProviderOptions } from "./contracts.ts";
import { contextUsageFormat, contextUsageKey, restoreContextUsage } from "./context-usage.ts";
import { encode } from "./encode.ts";
import { event, response } from "./decode.ts";

/** Bind a selected SDK model to scoped canonical inference. Each subscription opens
 * one request; scope exit aborts it and joins iterator.return when provided. No retry.
 * The SDK driver must honor abort and release pending reads. Text/reasoning/tools
 * are supported; unsupported modalities/options fail before dispatch. */
export function createPiAiProvider<Y>(
  runtime: Runtime<Y>,
  options: PiAiProviderOptions,
): ModelProvider<Y> {
  const model = structuredClone(options.model);
  const open = options.stream;
  const apiKey = options.apiKey;
  return {
    *stream(request) {
      const input = structuredClone(request);
      const accounting = yield* runtime.fromPromise(() =>
        restoreContextUsage(input.context, model),
      );
      const encoded = encode(input, model, accounting);
      const controller = new AbortController();
      let iterator: AsyncIterator<unknown> | undefined;
      let active = true;
      let reading = false;
      let completed: ModelResponse | undefined;
      let failed: { error: unknown } | undefined;
      function wait<T>(work: () => Promise<T>): Operation<T, Y> {
        return runtime.fromPromise((signal) => {
          const abort = () => {
            failed = { error: new Error("Model request aborted") };
            controller.abort();
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            abort();
            signal.removeEventListener("abort", abort);
            return Promise.reject(new Error("Model request aborted"));
          }
          return Promise.resolve()
            .then(work)
            .finally(() => signal.removeEventListener("abort", abort));
        });
      }
      yield* runtime.composition.ensure(function* () {
        active = false;
        controller.abort();
        if (iterator?.return) {
          yield* runtime.fromPromise(() => iterator!.return!());
        }
      });
      const source = open(structuredClone(model), encoded.context, {
        ...encoded.options,
        apiKey,
        maxRetries: 0,
        signal: controller.signal,
      });
      const incoming = source[Symbol.asyncIterator]();
      iterator = incoming;
      return {
        *next(): Operation<IteratorResult<ModelStreamEvent, ModelResponse>, Y> {
          return yield* runtime.using(
            function* () {
              if (!active) {
                throw new Error("Model subscription scope exited");
              }
              if (reading) {
                throw new Error("Concurrent model reads are unsupported");
              }
              reading = true;
            },
            function* () {
              if (failed) {
                throw failed.error;
              }
              if (completed) {
                return { done: true as const, value: completed };
              }
              return yield* runtime.composition.catchError(
                function* (): Operation<IteratorResult<ModelStreamEvent, ModelResponse>, Y> {
                  const next = yield* wait(() => incoming.next());
                  if (!next.done) {
                    return { done: false, value: event(next.value) };
                  }
                  const result = yield* wait(() => source.result());
                  completed = response(result);
                  if (completed.usage) {
                    const key = yield* wait(() =>
                      contextUsageKey(
                        {
                          ...input.context,
                          messages: [...input.context.messages, completed!.message],
                        },
                        model,
                      ),
                    );
                    completed = {
                      ...completed,
                      message: {
                        ...completed.message,
                        contextUsage: {
                          usage: structuredClone(completed.usage),
                          basis: { format: contextUsageFormat, key },
                        },
                      },
                    };
                  }
                  return { done: true, value: completed };
                },
                function* (error) {
                  failed = { error };
                  controller.abort();
                  throw error;
                },
              );
            },
            function* () {
              reading = false;
            },
          );
        },
      };
    },
  };
}
