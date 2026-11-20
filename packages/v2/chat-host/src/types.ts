import type { Operation } from "@standard-durability/core";
import type { JournalReader } from "@sweatpan.ts/durable";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ChatHistoryMessage, ChatLoopRequest } from "@sweatpan.ts/chat";
import type { ChatToolDefinition } from "@sweatpan.ts/providers";
import type { ChatProgramOptions } from "./contracts.ts";
import type { ChatLoopSample } from "@sweatpan.ts/chat";

/** Stored sampling input: compact identity of the conversation and tool catalog. */
export interface RecordedChatRequest {
  readonly round: number;
  readonly historyLength: number;
  readonly historyHash: string;
}

/** Model batch fields used for routing; provider-specific signatures stay on the sample. */
export interface RecordedChatCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** Decoded successful recorded-chat effects used to rebuild exact model history. */
export type RecordedChatEntry =
  | {
      readonly kind: "sample";
      readonly request: RecordedChatRequest;
      readonly sample: ChatLoopSample;
    }
  | {
      readonly kind: "tools";
      readonly calls: readonly RecordedChatCall[];
      readonly values: readonly unknown[];
    };
/** Append-only conversation fingerprint shared by the Guest and retained projection. */
export interface HistoryFingerprint {
  append(value: unknown): void;
  digest(): string;
}

/** A per-run cache reconstructed from accepted recorded-chat outcomes. */
export interface RecordedHistory<Y> {
  read(request: RecordedChatRequest): Operation<ChatLoopRequest, Y>;
  snapshot(): Operation<ChatLoopRequest, Y>;
}

/** Pinned projections and read authority used to reconstruct one execution. */
export interface RecordedHistoryOptions<R, Y> {
  readonly journal: JournalReader<R, CapabilityRequest, unknown, string, unknown, Y>;
  readonly program: string;
  readonly tools: readonly ChatToolDefinition[];
  initialHistory(admittedInput: unknown): Operation<readonly ChatHistoryMessage[], Y>;
  readonly toolResult: ChatProgramOptions<R>["toolResult"];
}
