import { EventType } from "@ag-ui/core";
import { call, race, type Operation } from "effection";
import { replaceControlCharacters } from "@sweatpants/foundation";
import { CrankError } from "@sweatpants/durable-execution";
import {
  ModelProviderApi,
  UnsupportedModelCapabilityError,
  type Model,
  type StreamOptions,
} from "@sweatpants/model-provider";
import { settleModelSample, type ModelSamplingService } from "@sweatpants/model-sampling";
import type { HistoryPolicy } from "@sweatpants/chat-core";
import { useLogger } from "../../logger/index.ts";
import type { ChatToolCatalog } from "../program-driver-schema.ts";
import { planModelInvocation } from "./plan.ts";
import { TurnEventApi } from "./turn-event-api.ts";

const MAX_PARTIAL_TEXT_LENGTH = 32_768;

export function safeProviderErrorMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
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
  /** Execution-owned samples must use a relay, not the Host Turn event writer. */
  emitLiveEvents?: boolean;
  onLiveMessageStarted?: (messageId: string) => void;
  onLiveMessageEnded?: (messageId: string) => void;
}): ModelSamplingService {
  return {
    // Provider streaming intentionally keeps plan, delivery, settlement, and cancellation in one pump.
    // fallow-ignore-next-line complexity
    *sample(request, attempt) {
      const plan = planModelInvocation({
        request,
        attempt,
        model: options.model,
        ...(options.streamOptions ? { streamOptions: options.streamOptions } : {}),
        ...(options.catalog ? { catalog: options.catalog } : {}),
        ...(options.historyPolicy ? { historyPolicy: options.historyPolicy } : {}),
      });
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
      const publicFailureDetails = () =>
        streamStarted && plan.delivery.type === "outer-assistant" && partialText.length > 0
          ? {
              publicAssistantPartial: {
                messageId: plan.delivery.messageId,
                text: partialText,
              },
            }
          : undefined;
      return yield* race([
        (function* (): Operation<
          | { status: "ok"; value: ReturnType<typeof settleModelSample> }
          | { status: "cancelled"; partial: { text: string; interrupted: true } }
        > {
          try {
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
              return {
                status: "cancelled",
                partial: { text: partialText, interrupted: true },
              };
            }
            if (error instanceof CrankError) {
              throw new CrankError(error.code, error.message, publicFailureDetails(), {
                cause: error,
              });
            }
            if (error instanceof UnsupportedModelCapabilityError) {
              throw new CrankError(
                "unsupported_model_capability",
                error.message,
                publicFailureDetails(),
                { cause: error },
              );
            }
            throw new CrankError("model_runtime_failed", "Provider error", publicFailureDetails(), {
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
          return {
            status: "cancelled",
            partial: { text: partialText, interrupted: true },
          };
        })(),
      ]);
    },
  };
}
