import { CrankError } from "@sweatpants/durable-execution";
import { ModelProviderApi, type Model, type StreamOptions } from "@sweatpants/model-provider";
import {
  assistantToolCalls,
  settleModelSample,
  type ModelSamplingService,
} from "@sweatpants/model-sampling";
import type { HistoryPolicy } from "@sweatpants/chat-core";
import { useLogger } from "../../logger/index.ts";
import type { ChatToolCatalog } from "../program-driver-schema.ts";
import { planModelInvocation } from "./plan.ts";
import { TurnEventApi } from "./turn-event-api.ts";

const MAX_PARTIAL_TEXT_LENGTH = 32_768;

export function safeProviderErrorMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
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
  onTerminalStreamed?: () => void;
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
      try {
        const stream = yield* ModelProviderApi.operations.stream(plan.providerRequest);
        const subscription = yield* stream;
        while (true) {
          const next = yield* subscription.next();
          if (next.done) {
            const result = settleModelSample(plan.response, next.value);
            if (streamStarted && plan.delivery.type === "outer-assistant") {
              yield* TurnEventApi.operations.emit({
                type: "TEXT_MESSAGE_END",
                messageId: plan.delivery.messageId,
              });
              if (assistantToolCalls(result.message).length === 0) {
                options.onTerminalStreamed?.();
              }
            }
            return { status: "ok", value: result };
          }
          if (next.value.type === "text_delta") {
            if (partialText.length < MAX_PARTIAL_TEXT_LENGTH) {
              partialText += next.value.delta.slice(
                0,
                MAX_PARTIAL_TEXT_LENGTH - partialText.length,
              );
            }
            if (plan.delivery.type === "outer-assistant" && deliverOuter) {
              if (!streamStarted) {
                streamStarted = true;
                yield* TurnEventApi.operations.emit({
                  type: "TEXT_MESSAGE_START",
                  messageId: plan.delivery.messageId,
                  role: "assistant",
                });
              }
              yield* TurnEventApi.operations.emit({
                type: "TEXT_MESSAGE_CONTENT",
                messageId: plan.delivery.messageId,
                delta: next.value.delta,
              });
            }
          }
          if (next.value.type === "error") {
            const providerMessage = safeProviderErrorMessage(next.value.error.errorMessage);
            throw new CrankError(
              "model_runtime_failed",
              providerMessage ? `Model runtime failed: ${providerMessage}` : "Model runtime failed",
            );
          }
        }
      } catch (error) {
        if (attempt.cancellation.aborted) {
          return {
            status: "cancelled",
            partial: { text: partialText, interrupted: true },
          };
        }
        if (error instanceof CrankError) throw error;
        throw new CrankError("model_runtime_failed", "Provider error", undefined, { cause: error });
      }
    },
  };
}
