import type { Outcome } from "@standard-durability/core";
import type { ChatLoopRequest, ChatLoopSample, ChatSamplingError } from "@sweatpan.ts/chat";
import type { Stream } from "@sweatpan.ts/runtime";

/** App-local presentation adapter. Each item replaces the provisional text; only
 * the terminal result is eligible for acceptance by the existing chat Host. */
export interface TextSampling<Y> {
  stream(request: ChatLoopRequest): Stream<string, Outcome<ChatLoopSample, ChatSamplingError>, Y>;
}
