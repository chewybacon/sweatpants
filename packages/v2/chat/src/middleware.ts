import type { OperationMiddleware } from "@standard-durability/core";
import type { ChatLoopSample, ChatSampling } from "./contracts.ts";

/** Optional Host sampling middleware. Check before dispatch, then deny a final-round
 * tool batch before the Guest can invoke tools. Expected denials are returned as data;
 * when the caller records them, recovery cannot silently retry with a larger limit.
 * A completed but denied sample is retained in the error. No mutable round counter.
 * Configuration must be a positive safe integer. Install outside layers that may
 * short-circuit sampling when the limit must govern those results too. */
export function limitChatRounds<Y, Sample extends ChatLoopSample = ChatLoopSample>(
  maxRounds: number,
): OperationMiddleware<ChatSampling<Y, Sample>> {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new Error("Invalid chat round limit");
  }
  return {
    *sample([request], next) {
      if (!Number.isSafeInteger(request.round) || request.round < 0) {
        return { ok: false, error: { code: "invalid-round", message: "Invalid chat round" } };
      }
      if (request.round >= maxRounds) {
        return { ok: false, error: { code: "round-limit", message: "Chat round limit reached" } };
      }
      const result = yield* next(request);
      if (
        result.ok &&
        request.round + 1 === maxRounds &&
        result.value.response.message.content.some((part) => part.type === "tool-call")
      ) {
        return {
          ok: false,
          error: { code: "round-limit", message: "Chat round limit reached", sample: result.value },
        };
      }
      return result;
    },
  };
}
