import type { Outcome } from "@standard-durability/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ChatLoopSample } from "@sweatpan.ts/chat";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Accepted } from "@sweatpan.ts/durable";
import type { RecordedChatRequest } from "./types.ts";
import type { RecordedChatCall, RecordedChatEntry } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function decodeRecordedChatRequest(value: unknown): RecordedChatRequest {
  if (
    !isRecord(value) ||
    typeof value.round !== "number" ||
    !Number.isSafeInteger(value.round) ||
    value.round < 0 ||
    typeof value.historyLength !== "number" ||
    !Number.isSafeInteger(value.historyLength) ||
    value.historyLength < 0 ||
    typeof value.historyHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.historyHash)
  ) {
    throw new Error("Invalid recorded chat envelope");
  }
  return { round: value.round, historyLength: value.historyLength, historyHash: value.historyHash };
}

/** Validate the recorded envelope. Full provider/media validation belongs to the sampling adapter. */
function decodeSample(value: unknown): ChatLoopSample {
  if (
    !isRecord(value) ||
    !isRecord(value.model) ||
    ![value.model.provider, value.model.api, value.model.id].every(
      (part) => typeof part === "string" && part.length > 0,
    ) ||
    !isRecord(value.response) ||
    !isRecord(value.response.message) ||
    value.response.message.role !== "assistant" ||
    !Array.isArray(value.response.message.content)
  ) {
    throw new Error("Invalid recorded chat envelope");
  }
  return value as unknown as ChatLoopSample;
}

export function decodeRecordedChatCalls(input: unknown): readonly RecordedChatCall[] {
  if (!Array.isArray(input) || !input.length) {
    throw new Error("Empty or invalid chat batch");
  }
  const seen = new Set<string>();
  return input.map((value: unknown) => {
    if (
      !isRecord(value) ||
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

function decodeValues(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid recorded chat tool outcomes");
  }
  return value;
}

/** Reuse the same protocol decoders at effect admission and retained-history reads. */
function schema<T>(decode: (value: unknown) => T): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "sweatpan.ts/chat-host",
      validate(value) {
        try {
          return { value: decode(value) };
        } catch (error) {
          return { issues: [{ message: String(error) }] };
        }
      },
    },
  };
}

export const recordedChatRequestSchema: StandardSchemaV1<RecordedChatRequest> =
  schema(decodeRecordedChatRequest);
export const recordedChatSampleSchema: StandardSchemaV1<ChatLoopSample> = schema(decodeSample);
export const recordedChatCallsSchema: StandardSchemaV1<readonly RecordedChatCall[]> =
  schema(decodeRecordedChatCalls);
export const recordedChatValuesSchema: StandardSchemaV1<readonly unknown[]> = schema(decodeValues);

/** Preserve the authored sampling diagnostic while projecting an unknown failure value. */
export function recordedChatFailureMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === "string"
    ? error.message
    : "Chat sampling failed";
}

/** Decode both transport and sampling denial without exposing failure payloads. */
export function decodeRecordedChatSampleOutcome(outcome: unknown): ChatLoopSample | undefined {
  if (!isRecord(outcome) || typeof outcome.ok !== "boolean") {
    throw new Error("Invalid recorded chat outcome");
  }
  if (!outcome.ok) {
    return undefined;
  }
  const reply = outcome.value;
  if (!isRecord(reply) || typeof reply.ok !== "boolean") {
    throw new Error("Invalid recorded chat sampling outcome");
  }
  return reply.ok ? decodeSample(reply.value) : undefined;
}

function decodeAcceptedValue<T>(
  outcome: Outcome<unknown, string>,
  decode: (value: unknown) => T,
): T {
  if (!outcome.ok) {
    throw new Error("Recorded chat history contains an unsuccessful exchange");
  }
  const reply = outcome.value;
  if (!isRecord(reply) || reply.ok !== true || !("value" in reply)) {
    throw new Error("Recorded chat history contains an unsuccessful exchange");
  }
  return decode(reply.value);
}

export function decodeRecordedChatEntry(
  program: string,
  entry: Accepted<CapabilityRequest, unknown, string>,
): RecordedChatEntry {
  if (entry.request.effect === program + "/sample") {
    const sample = decodeRecordedChatSampleOutcome(entry.outcome);
    if (!sample) {
      throw new Error("Recorded chat history contains an unsuccessful exchange");
    }
    return { kind: "sample", request: decodeRecordedChatRequest(entry.request.input), sample };
  }
  if (entry.request.effect === program + "/tools") {
    const calls = decodeRecordedChatCalls(entry.request.input);
    const values = decodeAcceptedValue(entry.outcome, decodeValues);
    if (values.length !== calls.length) {
      throw new Error("Recorded chat batch result count differs from calls");
    }
    return { kind: "tools", calls, values };
  }
  throw new Error("Unknown recorded chat history effect");
}
