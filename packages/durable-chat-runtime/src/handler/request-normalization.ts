/**
 * Durable chat request normalization.
 *
 * Converts loosely-shaped incoming JSON into the canonical `ChatRequestBody`
 * message forms, and maps public AG-UI resume entries onto internal elicit
 * responses. Pure functions; no I/O, no contexts.
 */
import type { ChatRequestBody, ElicitResponse } from "./chat-types.ts";
import type { OpenInterruptRecord } from "../interrupts/index.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forwardedClientReplayTraces(forwardedProps: unknown): Record<string, unknown> {
  if (!isRecord(forwardedProps)) {
    return {};
  }
  const sweatpants = forwardedProps["sweatpants"];
  if (!isRecord(sweatpants)) {
    return {};
  }
  const traces = sweatpants["clientReplayTraces"];
  return isRecord(traces) ? traces : {};
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function normalizeIncomingMessages(messages: unknown): ChatRequestBody["messages"] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const normalized: ChatRequestBody["messages"] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isRecord(message)) {
      continue;
    }

    const role = message["role"];
    const id =
      typeof message["id"] === "string" && message["id"].length > 0
        ? message["id"]
        : `${typeof role === "string" ? role : "message"}:${index}`;
    const content =
      typeof message["content"] === "string"
        ? message["content"]
        : message["content"] === undefined
          ? ""
          : JSON.stringify(message["content"]);

    if (role === "assistant") {
      const toolCalls = Array.isArray(message["tool_calls"])
        ? message["tool_calls"]
        : Array.isArray(message["toolCalls"])
          ? message["toolCalls"]
          : [];
      normalized.push({
        id,
        role: "assistant" as const,
        content,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.filter(isRecord).map((toolCall) => {
                const fn = isRecord(toolCall["function"]) ? toolCall["function"] : {};
                return {
                  id: typeof toolCall["id"] === "string" ? toolCall["id"] : `tool:${index}`,
                  type: "function" as const,
                  function: {
                    name: typeof fn["name"] === "string" ? fn["name"] : "unknown",
                    arguments: parseToolArguments(fn["arguments"]),
                  },
                };
              }),
            }
          : {}),
      });
      continue;
    }

    if (role === "tool") {
      const toolCallId =
        typeof message["tool_call_id"] === "string"
          ? message["tool_call_id"]
          : typeof message["toolCallId"] === "string"
            ? message["toolCallId"]
            : "";
      normalized.push({ id, role: "tool" as const, content, tool_call_id: toolCallId });
      continue;
    }

    if (role === "activity") {
      const activityType =
        typeof message["activityType"] === "string"
          ? message["activityType"]
          : "sweatpants:activity";
      normalized.push({ id, role: "activity" as const, activityType, content });
      continue;
    }

    if (role === "developer") {
      normalized.push({ id, role: "developer" as const, content });
    } else if (role === "system") {
      normalized.push({ id, role: "system" as const, content });
    } else if (role === "reasoning") {
      normalized.push({ id, role: "reasoning" as const, content });
    } else if (role === "user") {
      normalized.push({ id, role: "user" as const, content });
    }
  }

  return normalized;
}

export function normalizeChatRequestBody(body: ChatRequestBody): ChatRequestBody {
  return {
    ...body,
    messages: normalizeIncomingMessages(body.messages),
  };
}

function mapResolvedResumePayload(payload: unknown): ElicitResponse["result"] {
  if (isRecord(payload) && payload["action"] === "accept") {
    return { action: "accept", content: payload["content"] };
  }
  if (isRecord(payload) && payload["action"] === "decline") {
    return { action: "decline" };
  }
  return { action: "accept", content: payload };
}

export function mapResumeEntriesToElicitResponses(
  body: ChatRequestBody,
  records: OpenInterruptRecord[],
  runtimeId: string,
): ElicitResponse[] {
  const resume = body.resume ?? [];
  if (resume.length === 0) {
    return [];
  }

  const traces = forwardedClientReplayTraces(body.forwardedProps);
  const recordsByInterruptId = new Map(records.map((record) => [record.interruptId, record]));
  const mapped: ElicitResponse[] = [];

  for (const entry of resume) {
    const record = recordsByInterruptId.get(entry.interruptId);
    if (!record?.toolCallId) {
      continue;
    }
    const result =
      entry.status === "cancelled"
        ? { action: "cancel" as const }
        : mapResolvedResumePayload(entry.payload);
    const sessionId = record.sessionId ?? record.executionId ?? record.toolCallId;
    const response: ElicitResponse = {
      sessionId,
      callId: record.toolCallId,
      ...(record.toolName ? { toolName: record.toolName } : {}),
      elicitId: entry.interruptId,
      result,
      ref: {
        runtimeId: record.runtimeId ?? runtimeId,
        executionId: record.executionId ?? sessionId,
        sessionId,
        callId: record.toolCallId,
        toolName: record.toolName ?? "",
      },
    };
    const trace = traces[entry.interruptId];
    if (trace !== undefined) {
      response.trace = trace as NonNullable<ElicitResponse["trace"]>;
    }
    mapped.push(response);
  }

  return mapped;
}
