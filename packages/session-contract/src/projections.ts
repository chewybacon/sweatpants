import { resource, type Operation, type Stream } from "effection";

import type { CrankStore, JournalRecord, PublicEnvelope, PublicEvent } from "./types.ts";

export function projectRecord(
  record: JournalRecord,
  journal: readonly JournalRecord[] = [],
): PublicEnvelope[] {
  const projected = projectEvent(record, journal);
  return projected.map((event, index) => ({
    cursor: record.offset,
    eventId: `${record.eventId}:public:${index}`,
    sessionId: record.sessionId,
    ...("turnId" in record.payload ? { turnId: record.payload.turnId } : {}),
    event,
  }));
}

export function publicEvents(
  store: CrankStore,
  sessionId: string,
  afterCursor = -1,
): Stream<PublicEnvelope, void> {
  return resource(function* (provide) {
    const source = yield* store.events(sessionId, afterCursor);
    const history: JournalRecord[] = yield* store.readJournal(sessionId);
    const queue: PublicEnvelope[] = [];
    yield* provide({
      *next(): Operation<IteratorResult<PublicEnvelope, void>> {
        while (queue.length === 0) {
          const next = yield* source.next();
          if (next.done) return { done: true, value: undefined };
          if (!history.some((record) => record.offset === next.value.offset))
            history.push(next.value);
          queue.push(...projectRecord(next.value, history));
        }
        return { done: false, value: queue.shift()! };
      },
    });
  });
}

function projectEvent(record: JournalRecord, journal: readonly JournalRecord[]): PublicEvent[] {
  const payload = record.payload;
  switch (payload.type) {
    case "turn_opened":
      return [{ type: "turn_started" }];
    case "task_opened": {
      const input =
        payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
          ? payload.input
          : {};
      const callId = typeof input["callId"] === "string" ? input["callId"] : payload.taskId;
      const name =
        typeof input["target"] === "string" ? input["target"] : publicToolName(payload.programId);
      const publicInput = input["input"];
      return [
        {
          type: "tool_started",
          toolCallId: callId,
          name,
          ...(publicInput !== undefined ? { input: publicInput } : {}),
        },
      ];
    }
    case "pull_requested":
      return payload.descriptor.kind === "elicit"
        ? [
            {
              type: "input_requested",
              pullId: payload.pullId,
              key: payload.descriptor.input.key,
              message: payload.descriptor.input.message,
              responseSchema: payload.descriptor.input.responseSchema,
              ...(payload.descriptor.input.context !== undefined
                ? { context: payload.descriptor.input.context }
                : {}),
            },
          ]
        : [];
    case "pull_resolved": {
      const request = journal.find(
        (candidate) =>
          candidate.payload.type === "pull_requested" &&
          candidate.payload.pullId === payload.pullId,
      );
      return request?.payload.type === "pull_requested" &&
        request.payload.descriptor.kind === "elicit"
        ? [{ type: "input_resolved", pullId: payload.pullId }]
        : [];
    }
    case "attempt_started": {
      const request = journal.find(
        (candidate) =>
          candidate.payload.type === "pull_requested" &&
          candidate.payload.pullId === payload.pullId,
      );
      if (
        request?.payload.type === "pull_requested" &&
        request.payload.descriptor.kind === "effect" &&
        request.payload.descriptor.effectId === "model.sample"
      ) {
        return [{ type: "text_started", messageId: payload.pullId, attemptId: payload.attemptId }];
      }
      return [];
    }
    case "attempt_abandoned":
      return [{ type: "attempt_abandoned", attemptId: payload.attemptId }];
    case "durable_emission":
      return publicEmission(payload.emission, payload.pullId, payload.attemptId);
    case "task_closed": {
      if (payload.taskId.endsWith("/root")) {
        if (payload.result.status === "ok")
          return [{ type: "turn_finished", outcome: "completed" }];
        if (payload.result.status === "cancelled")
          return [{ type: "turn_finished", outcome: "cancelled" }];
        return [
          {
            type: "turn_finished",
            outcome: "error",
            code: payload.result.error.code,
            message: payload.result.error.message,
          },
        ];
      }
      const opened = journal.find(
        (candidate) =>
          candidate.payload.type === "task_opened" && candidate.payload.taskId === payload.taskId,
      );
      const input =
        opened?.payload.type === "task_opened" &&
        opened.payload.input &&
        typeof opened.payload.input === "object" &&
        !Array.isArray(opened.payload.input)
          ? opened.payload.input
          : {};
      const callId = typeof input["callId"] === "string" ? input["callId"] : payload.taskId;
      return [
        {
          type: "tool_completed",
          toolCallId: callId,
          ...(payload.result.status === "ok" ? { result: payload.result.value } : {}),
        },
      ];
    }
    case "session_closed":
      return [
        {
          type: "session_closed",
          ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        },
      ];
    case "command":
      return [];
  }
}

function publicEmission(emission: unknown, pullId: string, attemptId: string): PublicEvent[] {
  if (!emission || typeof emission !== "object") return [];
  const event = emission as Record<string, unknown>;
  const type = event["type"];
  const nested =
    event["payload"] && typeof event["payload"] === "object"
      ? (event["payload"] as Record<string, unknown>)
      : event;
  if (type === "text_delta" || (type === "emit" && nested["type"] === "text_delta")) {
    return [
      {
        type: "text_delta",
        messageId: typeof nested["messageId"] === "string" ? nested["messageId"] : pullId,
        attemptId,
        delta: typeof nested["delta"] === "string" ? nested["delta"] : "",
      },
    ];
  }
  if (type === "message_committed") {
    return [{ type: "message_committed", message: nested["message"] as never }];
  }
  // AG-UI adapters may explicitly place a public event in an emission.
  if (
    typeof type === "string" &&
    ["text_started", "tool_started", "tool_completed"].includes(type)
  ) {
    return [emission as PublicEvent];
  }
  return [];
}

function publicToolName(programId: string): string {
  return programId.startsWith("tool.") ? programId.slice(5) : programId;
}
