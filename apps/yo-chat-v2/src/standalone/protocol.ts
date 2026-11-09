import type { StandaloneAnswer, StandaloneView, QuestionRecord } from "./contracts.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid tool HTTP object");
  }
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("Invalid tool HTTP identity");
  }
  return value;
}
function grant(value: unknown) {
  const data = object(value);
  return { requestId: string(data.requestId), resolutionId: string(data.resolutionId) };
}
/** Decode the transport envelope only. Original effect schemas validate domain answers. */
export function parseStandaloneAnswer(value: unknown): StandaloneAnswer {
  const data = object(value);
  const outcome = object(data.outcome);
  if (outcome.ok === true && Object.hasOwn(outcome, "value")) {
    return { grant: grant(data.grant), outcome: { ok: true, value: outcome.value } };
  }
  if (outcome.ok === false && Object.hasOwn(outcome, "error")) {
    return { grant: grant(data.grant), outcome: { ok: false, error: outcome.error } };
  }
  throw new Error("Invalid tool HTTP outcome");
}
/** Decode detached JSON state; result payloads remain unknown until the consumer's contract. */
export function parseStandaloneView(value: unknown): StandaloneView {
  const data = object(value);
  if (data.version !== "tool-http/1") {
    throw new Error("Unsupported tool HTTP version");
  }
  const base = {
    version: "tool-http/1" as const,
    execution: string(data.execution),
    program: string(data.program),
    questions: questions(data.questions),
  };
  switch (data.status) {
    case "running":
      return { ...base, status: "running" };
    case "waiting": {
      const question = object(data.question);
      if (!Object.hasOwn(question, "input")) {
        throw new Error("Missing tool question input");
      }
      return {
        ...base,
        status: "waiting",
        question: {
          effect: string(question.effect),
          input: question.input,
          grant: grant(question.grant),
        },
      };
    }
    case "completed": {
      if (!Object.hasOwn(data, "value")) {
        throw new Error("Missing tool result");
      }
      return { ...base, status: "completed", value: data.value };
    }
    case "cancelled": {
      if (typeof data.reason !== "string") {
        throw new Error("Invalid cancellation reason");
      }
      return { ...base, status: "cancelled", reason: data.reason };
    }
    default:
      throw new Error("Invalid tool HTTP state");
  }
}

function questions(value: unknown): readonly QuestionRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Missing tool question history");
  }
  let previous = -1;
  return value.map((item) => {
    const data = object(item);
    if (
      typeof data.sequence !== "number" ||
      !Number.isSafeInteger(data.sequence) ||
      data.sequence <= previous ||
      !Object.hasOwn(data, "input")
    ) {
      throw new Error("Invalid tool question history");
    }
    previous = data.sequence;
    const base = { sequence: data.sequence, effect: string(data.effect), input: data.input };
    if (data.state === "waiting" || data.state === "cancelled" || data.state === "blocked") {
      return { ...base, state: data.state };
    }
    if (data.state === "failed") {
      return { ...base, state: "failed", error: string(data.error) };
    }
    if (data.state === "answered") {
      const outcome = object(data.outcome);
      if (outcome.ok === true && Object.hasOwn(outcome, "value")) {
        return { ...base, state: "answered", outcome: { ok: true, value: outcome.value } };
      }
      if (outcome.ok === false && Object.hasOwn(outcome, "error")) {
        return { ...base, state: "answered", outcome: { ok: false, error: outcome.error } };
      }
    }
    throw new Error("Invalid tool question state");
  });
}
