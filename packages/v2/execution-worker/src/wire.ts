import type { GuestCommand } from "./types.ts";
import type { Turn } from "@sweatpan.ts/execution";

function envelope(input: unknown): Record<string, unknown> {
  const value = object(input);
  if (
    typeof value.incarnation !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0
  ) {
    throw new Error("Invalid Guest correlation");
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Guest envelope");
  }
  return value as Record<string, unknown>;
}
export function decodeCommand<V, E>(input: unknown): GuestCommand<V, E> {
  const value = envelope(input);
  if (value.action === "initialize") {
    const invocation = object(value.invocation);
    if (
      typeof invocation.program !== "string" ||
      invocation.program.length === 0 ||
      !("input" in invocation) ||
      (value.checkpointFormat !== undefined && typeof value.checkpointFormat !== "string")
    ) {
      throw new Error("Invalid Guest initialization");
    }
  } else if (value.action === "resume") {
    const outcome = object(value.outcome);
    if (
      (outcome.ok !== true && outcome.ok !== false) ||
      !(outcome.ok ? "value" in outcome : "error" in outcome)
    ) {
      throw new Error("Invalid Guest Outcome");
    }
  } else if (value.action === "cancel") {
    if (typeof value.reason !== "string") {
      throw new Error("Invalid cancellation reason");
    }
  } else if (value.action === "capture" || value.action === "restore") {
    if (typeof value.format !== "string" || (value.action === "restore" && !("state" in value))) {
      throw new Error("Invalid Guest checkpoint command");
    }
  } else if (value.action !== "start" && value.action !== "close") {
    throw new Error("Invalid Guest command");
  }
  // Application payloads belong to the trusted codec/program contract; schemas run in hosting.
  return value as unknown as GuestCommand<V, E>;
}
export function decodeTurn<R, Q>(input: unknown): Turn<R, Q> {
  const turn = object(input);
  if (turn.kind === "suspended") {
    if (!("request" in turn)) {
      throw new Error("Missing Guest request");
    }
    if (turn.scope !== undefined) {
      const scope = object(turn.scope);
      if (
        typeof scope.scopeId !== "string" ||
        typeof scope.frameId !== "string" ||
        (scope.phase !== "body" && scope.phase !== "cleanup") ||
        (scope.critical !== undefined && typeof scope.critical !== "string")
      ) {
        throw new Error("Invalid Guest scope");
      }
    }
  } else if (turn.kind === "completed") {
    if (!("value" in turn)) {
      throw new Error("Missing Guest result");
    }
  } else if (turn.kind === "cancelled") {
    if (
      typeof turn.reason !== "string" ||
      (turn.failure !== undefined && typeof turn.failure !== "string")
    ) {
      throw new Error("Invalid cancelled Guest turn");
    }
  } else {
    throw new Error("Invalid Guest turn");
  }
  return turn as unknown as Turn<R, Q>;
}
