import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeRecordedValue } from "./value.ts";
import { readAcceptedHistoryPage, type AcceptedHistoryCursor } from "@sweatpan.ts/durable";
import type { Operation } from "@standard-durability/core";
import type { ChatHistoryMessage, ChatLoopRequest } from "@sweatpan.ts/chat";
import type { ChatToolDefinition } from "@sweatpan.ts/providers";
import { decodeRecordedChatEntry } from "./protocol.ts";
import type { HistoryFingerprint, RecordedHistory, RecordedHistoryOptions } from "./types.ts";
import type { RecordedChatRequest } from "./types.ts";

/** Append-only, portable fingerprint shared by the Guest and the retained projection. */
export function createHistoryFingerprint(tools: readonly ChatToolDefinition[]): HistoryFingerprint {
  const hash = sha256.create();
  const encoder = new TextEncoder();
  function append(value: unknown) {
    const text = encodeRecordedValue(value);
    hash.update(encoder.encode(text + "\n"));
  }
  append(tools);
  return {
    append,
    digest: () => bytesToHex(hash.clone().digest()),
  };
}

/** One run's cache, advanced exclusively from a captured accepted journal prefix. */
export function createRecordedHistory<R, Y>(
  options: RecordedHistoryOptions<R, Y>,
): RecordedHistory<Y> {
  let messages: ChatHistoryMessage[] | undefined;
  let fingerprint = createHistoryFingerprint(options.tools);
  let cursor: AcceptedHistoryCursor | undefined;
  let round = 0;
  function append(message: ChatHistoryMessage) {
    const retained = structuredClone(message);
    messages!.push(retained);
    fingerprint.append(retained);
  }
  function verify(request: RecordedChatRequest) {
    if (
      request.round !== round ||
      request.historyLength !== messages!.length ||
      request.historyHash !== fingerprint.digest()
    ) {
      throw new Error("Recorded chat conversation boundary mismatch");
    }
  }
  function* project(request?: RecordedChatRequest): Operation<ChatLoopRequest, Y> {
    let complete = false;
    try {
      const snapshot = yield* options.journal.read();
      if (snapshot.program !== options.program || !snapshot.admission) {
        throw new Error("Recorded chat history requires its admitted program");
      }
      const history = snapshot.history;
      if (!messages) {
        messages = [];
        const initial = yield* options.initialHistory(snapshot.admission.input);
        for (const message of initial) {
          append(message);
        }
      }
      let caughtUp = false;
      while (!caughtUp) {
        const page = yield* readAcceptedHistoryPage(options.journal.id, history, cursor);
        for (const entry of page.entries) {
          const decoded = decodeRecordedChatEntry(options.program, entry);
          if (decoded.kind === "sample") {
            verify(decoded.request);
            append({ ...decoded.sample.response.message, model: decoded.sample.model });
            round++;
          } else {
            const requested = decoded.calls;
            const assistant = messages.at(-1);
            const calls =
              assistant?.role === "assistant"
                ? assistant.content.flatMap((part) =>
                    part.type === "tool-call" ? [part.toolCall] : [],
                  )
                : [];
            if (
              !calls.length ||
              calls.length !== requested.length ||
              calls.some(
                (call, index) =>
                  encodeRecordedValue({ id: call.id, name: call.name, input: call.input }) !==
                  encodeRecordedValue({
                    id: requested[index]!.id,
                    name: requested[index]!.name,
                    input: requested[index]!.input,
                  }),
              )
            ) {
              throw new Error("Recorded chat batch differs from the accepted model calls");
            }
            const values = decoded.values;
            for (const [index, call] of calls.entries()) {
              const result = options.toolResult(values[index], structuredClone(call));
              append({
                role: "tool",
                toolCallId: call.id,
                name: call.name,
                content: result.content,
                isError: result.isError,
              });
            }
          }
        }
        cursor = page.after;
        caughtUp = page.caughtUp;
      }
      if (request) {
        verify(request);
      }
      const result = {
        round,
        history: structuredClone(messages),
        tools: structuredClone(options.tools),
      };
      complete = true;
      return result;
    } finally {
      if (!complete) {
        messages = undefined;
        fingerprint = createHistoryFingerprint(options.tools);
        cursor = undefined;
        round = 0;
      }
    }
  }
  return { read: project, snapshot: () => project() };
}
