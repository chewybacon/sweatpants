import type { GuestCommand, GuestResponse } from "./types.ts";
import type { GuestWireCodec } from "./contracts.ts";

function envelope(codec: GuestWireCodec, bytes: unknown): Record<string, unknown> {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Expected Guest wire bytes");
  }
  const value = object(codec.decode(bytes));
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
export function decodeCommand<V, E>(codec: GuestWireCodec, bytes: unknown): GuestCommand<V, E> {
  const value = envelope(codec, bytes);
  if (value.action === "resume") {
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
  } else if (value.action !== "start" && value.action !== "close") {
    throw new Error("Invalid Guest command");
  }
  // Application payloads belong to the trusted codec/program contract; schemas run in hosting.
  return value as unknown as GuestCommand<V, E>;
}
export function decodeResponse<R, Q>(codec: GuestWireCodec, bytes: unknown): GuestResponse<R, Q> {
  const value = envelope(codec, bytes);
  if (value.kind === "turn") {
    const turn = object(value.turn);
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
  } else if (value.kind === "error") {
    if (typeof value.message !== "string") {
      throw new Error("Invalid Guest error");
    }
  } else if (value.kind !== "closed") {
    throw new Error("Invalid Guest response");
  }
  return value as unknown as GuestResponse<R, Q>;
}
