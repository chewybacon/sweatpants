import type { AGUIEvent } from "@ag-ui/core";
import type { ConversationWindowFrame } from "./conversation-window.ts";

export const CONVERSATION_AUTHORITY_FRAME_TYPE = "sweatpants.conversation-authority.v1" as const;

interface IdleConversationAuthority {
  readonly conversationId: string;
  readonly revision: string | null;
  readonly state: "idle";
  readonly activeLogicalTurnId: null;
  readonly activeExecutionId: null;
  readonly latestCompletedExecutionId: string | null;
}

interface ActiveConversationAuthority {
  readonly conversationId: string;
  readonly revision: string;
  readonly state: "running" | "parked" | "recovering";
  readonly activeLogicalTurnId: string;
  readonly activeExecutionId: string;
  readonly latestCompletedExecutionId: string | null;
}

interface DeletedConversationAuthority {
  readonly conversationId: string;
  readonly revision: string;
  readonly state: "deleted";
  readonly activeLogicalTurnId: null;
  readonly activeExecutionId: null;
  readonly latestCompletedExecutionId: string | null;
}

/** Public, versioned projection of durable conversation admission authority. */
export type ConversationAuthority =
  | IdleConversationAuthority
  | ActiveConversationAuthority
  | DeletedConversationAuthority;

/** Sweatpants control-plane frame. It is not an AG-UI presentation event. */
export interface ConversationAuthorityFrame {
  readonly type: typeof CONVERSATION_AUTHORITY_FRAME_TYPE;
  readonly authority: ConversationAuthority;
}

/** Ordered chat transport protocol: presentation plus durable authority/window evidence. */
export type ConversationStreamEvent =
  | AGUIEvent
  | ConversationAuthorityFrame
  | ConversationWindowFrame;

function protocolError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: "chat_authority_invalid" });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactAuthorityKeys(value: Record<string, unknown>, path: string): void {
  const keys = new Set([
    "conversationId",
    "revision",
    "state",
    "activeLogicalTurnId",
    "activeExecutionId",
    "latestCompletedExecutionId",
  ]);
  for (const key of keys) {
    if (!(key in value)) {
      throw protocolError(`${path}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw protocolError(`${path}.${key} is not allowed`);
    }
  }
}

function boundedIdentity(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw protocolError(`${path} must be a bounded non-empty string`);
  }
  return value;
}

const MAX_DURABLE_COUNTER = 18_446_744_073_709_551_615n;

function revision(value: unknown, path: string, nullable: boolean): string | null {
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw protocolError(`${path} must be a canonical durable decimal counter`);
  }
  if (BigInt(value) > MAX_DURABLE_COUNTER) {
    throw protocolError(`${path} exceeds the durable 64-bit counter range`);
  }
  return value;
}

function nullableIdentity(value: unknown, path: string): string | null {
  return value === null ? null : boundedIdentity(value, path);
}

/** Parse one complete authority value and enforce state/identity invariants. */
export function decodeConversationAuthority(value: unknown): ConversationAuthority {
  const input = record(value, "authority");
  exactAuthorityKeys(input, "authority");
  const conversationId = boundedIdentity(input["conversationId"], "authority.conversationId");
  const state = input["state"];
  const latestCompletedExecutionId = nullableIdentity(
    input["latestCompletedExecutionId"],
    "authority.latestCompletedExecutionId",
  );

  if (state === "idle") {
    if (input["activeLogicalTurnId"] !== null || input["activeExecutionId"] !== null) {
      throw protocolError("idle authority must not identify an active Turn");
    }
    return {
      conversationId,
      revision: revision(input["revision"], "authority.revision", true),
      state,
      activeLogicalTurnId: null,
      activeExecutionId: null,
      latestCompletedExecutionId,
    };
  }

  if (state === "running" || state === "parked" || state === "recovering") {
    return {
      conversationId,
      revision: revision(input["revision"], "authority.revision", false)!,
      state,
      activeLogicalTurnId: boundedIdentity(
        input["activeLogicalTurnId"],
        "authority.activeLogicalTurnId",
      ),
      activeExecutionId: boundedIdentity(input["activeExecutionId"], "authority.activeExecutionId"),
      latestCompletedExecutionId,
    };
  }

  if (state === "deleted") {
    if (input["activeLogicalTurnId"] !== null || input["activeExecutionId"] !== null) {
      throw protocolError("deleted authority must not identify an active Turn");
    }
    return {
      conversationId,
      revision: revision(input["revision"], "authority.revision", false)!,
      state,
      activeLogicalTurnId: null,
      activeExecutionId: null,
      latestCompletedExecutionId,
    };
  }

  throw protocolError(`authority.state is invalid: ${String(state)}`);
}

export function decodeConversationAuthorityFrame(value: unknown): ConversationAuthorityFrame {
  const input = record(value, "authorityFrame");
  const keys = Object.keys(input);
  if (
    keys.length !== 2 ||
    !keys.includes("type") ||
    !keys.includes("authority") ||
    input["type"] !== CONVERSATION_AUTHORITY_FRAME_TYPE
  ) {
    throw protocolError("authorityFrame must contain exactly type and authority");
  }
  return {
    type: CONVERSATION_AUTHORITY_FRAME_TYPE,
    authority: decodeConversationAuthority(input["authority"]),
  };
}

export function isConversationAuthorityFrame(
  value: ConversationStreamEvent,
): value is ConversationAuthorityFrame {
  return value.type === CONVERSATION_AUTHORITY_FRAME_TYPE;
}

/** Pure monotonic fold for one conversation's authority read model. */
export function advanceConversationAuthority(
  current: ConversationAuthority | null,
  incoming: ConversationAuthority,
  conversationId: string,
): ConversationAuthority {
  if (incoming.conversationId !== conversationId) {
    throw protocolError(
      `authority for ${incoming.conversationId} cannot control ${conversationId}`,
    );
  }
  if (current === null) {
    return incoming;
  }
  const order = compareAuthorityRevisions(incoming.revision, current.revision);
  if (order < 0) {
    return current;
  }
  if (order === 0 && JSON.stringify(incoming) !== JSON.stringify(current)) {
    throw protocolError(`authority revision ${String(incoming.revision)} has conflicting content`);
  }
  return incoming;
}

/** Durable counters are decimal strings; null is the pre-head revision. */
export function compareAuthorityRevisions(left: string | null, right: string | null): number {
  const canonicalLeft = revision(left, "left revision", true);
  const canonicalRight = revision(right, "right revision", true);
  if (canonicalLeft === canonicalRight) {
    return 0;
  }
  if (canonicalLeft === null) {
    return -1;
  }
  if (canonicalRight === null) {
    return 1;
  }
  const leftCounter = BigInt(canonicalLeft);
  const rightCounter = BigInt(canonicalRight);
  return leftCounter < rightCounter ? -1 : 1;
}
