import type { OperationOutcome, SerializedEffectError } from "@sweatpants/durable-effects";
import { CrankError, type DurableForkExpiry } from "@sweatpants/durable-execution";
import { stableTupleHash, type Json, canonicalDigest } from "@sweatpants/foundation";

/**
 * Fork-group core: closed policy union, expiry resolution, terminal algebra,
 * and the pure reducer over member terminals.
 *
 * Spec: durable-execution-spine REQ-021..REQ-034. This module is pure data
 * and pure functions; all journal evidence is appended by the decision
 * handlers that call it. Unit-testable without a shell (test-plan TC-017,
 * TC-020, TC-021, TC-022).
 */

/** Closed fork-policy union. Incompatible mode/supervision pairs are
 *  unrepresentable: each mode carries its required supervision as a literal
 *  (REQ-025). */
export type ForkPolicy =
  | { readonly mode: "single"; readonly supervision: "single" }
  | { readonly mode: "all"; readonly supervision: "one_for_all" }
  | { readonly mode: "race"; readonly supervision: "first_success" };

const REQUIRED_SUPERVISION: Record<ForkPolicy["mode"], ForkPolicy["supervision"]> = {
  single: "single",
  all: "one_for_all",
  race: "first_success",
};

/** Admission-level pairing check (REQ-025 acceptance: a mismatched pair fails
 *  even when it arrives over the wire as raw data). */
export function assertForkPolicyPairing(policy: {
  mode: string;
  supervision: string;
}): asserts policy is ForkPolicy {
  const required = REQUIRED_SUPERVISION[policy.mode as ForkPolicy["mode"]];
  if (required === undefined || required !== policy.supervision) {
    throw new CrankError(
      "invalid_descriptor",
      `Fork mode ${String(policy.mode)} requires supervision ${String(
        required,
      )}, got ${String(policy.supervision)}`,
    );
  }
}

/** Expiry policy carried by every fork descriptor (REQ-030). There is no
 *  default and no library constant; unresolved or expired policies fail
 *  admission closed. Canonical type lives with the descriptor contract. */
export type ForkExpiryPolicy = DurableForkExpiry;

/**
 * Resolves an absolute deadline for a fork group. Fail-closed
 * (REQ-030): malformed, already-expired, or unresolvable policies throw;
 * effective deadlines never exceed the ancestor deadline.
 *
 * `ancestorDeadlineMs` is the parent task's resolved deadline
 * (`undefined` only for a session root with no policy).
 */
export function resolveForkDeadline(
  policy: ForkExpiryPolicy,
  ancestorDeadlineMs: number | undefined,
  nowMs: number,
): number {
  let candidate: number;
  switch (policy.kind) {
    case "at":
      if (!Number.isFinite(policy.atMs)) {
        throw new CrankError("invalid_descriptor", "Fork expiry deadline is not finite");
      }
      candidate = policy.atMs;
      break;
    case "after":
      if (!Number.isSafeInteger(policy.durationMs) || policy.durationMs < 0) {
        throw new CrankError("invalid_descriptor", "Fork expiry duration is invalid");
      }
      candidate = nowMs + policy.durationMs;
      break;
    case "inherit":
      if (ancestorDeadlineMs === undefined) {
        throw new CrankError(
          "fork_expiry_unresolvable",
          "Fork expiry inherits but no ancestor policy exists",
        );
      }
      return ancestorDeadlineMs;
    default:
      throw new CrankError("invalid_descriptor", "Unknown fork expiry policy");
  }
  if (candidate <= nowMs) {
    throw new CrankError("fork_expiry_unresolvable", "Fork expiry deadline is already past");
  }
  if (ancestorDeadlineMs !== undefined && candidate > ancestorDeadlineMs) {
    candidate = ancestorDeadlineMs;
  }
  return candidate;
}

/** A member's whole biography crossing the strand boundary as data. */
export interface ForkMemberBiography {
  readonly ordinal: number;
  readonly taskId: string;
  readonly outcome: OperationOutcome;
}

/** The closed five-ending algebra a fork slot resolves to (REQ-026).
 *  Ancestors exhaustively handle these five endings forever; a member's
 *  biography reaches its parent only inside this value. */
export type ForkGroupTerminal =
  | {
      readonly status: "completed";
      readonly winnerOrdinal?: number;
      readonly outcomes: readonly ForkMemberBiography[];
    }
  | {
      readonly status: "failed";
      readonly error: SerializedEffectError;
      readonly outcomes: readonly ForkMemberBiography[];
    }
  | { readonly status: "cancelled"; readonly outcomes: readonly ForkMemberBiography[] }
  | { readonly status: "expired"; readonly outcomes: readonly ForkMemberBiography[] }
  | { readonly status: "orphaned"; readonly reason: string };

export type CompletedForkGroupTerminal = Extract<
  ForkGroupTerminal,
  { readonly status: "completed" }
>;

/** Decodes the only terminal value that may cross a successful fork pull. */
export function completedForkGroupTerminal(value: unknown): CompletedForkGroupTerminal {
  if (!isCompletedForkGroupTerminal(value)) {
    throw new CrankError(
      "invalid_journal",
      "Successful fork-group outcome is not a completed terminal",
    );
  }
  return value;
}

function isCompletedForkGroupTerminal(value: unknown): value is CompletedForkGroupTerminal {
  const record = jsonRecord(value);
  if (!record || record["status"] !== "completed") return false;
  const winnerOrdinal = record["winnerOrdinal"];
  if (
    winnerOrdinal !== undefined &&
    (typeof winnerOrdinal !== "number" || !Number.isSafeInteger(winnerOrdinal) || winnerOrdinal < 0)
  ) {
    return false;
  }
  const outcomes = record["outcomes"];
  return Array.isArray(outcomes) && outcomes.every(isForkMemberBiography);
}

function isForkMemberBiography(value: unknown): value is ForkMemberBiography {
  const record = jsonRecord(value);
  if (!record) return false;
  const ordinal = record["ordinal"];
  const taskId = record["taskId"];
  return (
    typeof ordinal === "number" &&
    Number.isSafeInteger(ordinal) &&
    ordinal >= 0 &&
    typeof taskId === "string" &&
    isOperationOutcome(record["outcome"])
  );
}

function isOperationOutcome(value: unknown): value is OperationOutcome {
  const record = jsonRecord(value);
  if (!record || typeof record["status"] !== "string") return false;
  switch (record["status"]) {
    case "ok":
      return Object.prototype.hasOwnProperty.call(record, "value");
    case "cancelled":
      return true;
    case "error": {
      const error = jsonRecord(record["error"]);
      return typeof error?.["code"] === "string" && typeof error["message"] === "string";
    }
    default:
      return false;
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface ForkGroupMember {
  readonly ordinal: number;
  readonly taskId: string;
  /** Closed durability class (REQ-035); absent means crank_native. */
  readonly durability?: "crank_native" | "peer_hosted";
  /** Peer endpoint identity and declared sampling mode (REQ-042). */
  readonly peer?: string;
  readonly sampling?: "delegated" | "private";
  /** Stable delivery correlator, set when the delegation record commits
   *  (REQ-038: journal-first, stable across retries). */
  delegationCorrelator?: string;
  readonly terminal?: {
    readonly outcome: OperationOutcome;
    readonly outcomeDigest: string;
  };
}

/** Deterministic delivery identity: retries reuse it, peers dedupe by it. */
export function peerDeliveryCorrelator(groupId: string, memberTaskId: string): string {
  return stableTupleHash(["peer-delivery", groupId, memberTaskId]);
}

/** The typed outcome for a lost peer continuation (REQ-043): data, not a hang. */
export function peerLossOutcome(reason: string): OperationOutcome {
  return {
    status: "error",
    error: {
      code: "peer_lost",
      message: `Peer continuation lost: ${reason}`,
      details: { reason },
    },
  };
}

export type ForkGroupStatus = "open" | "cancelling" | "resolved";

export interface ForkGroupState {
  /** Monotonic materialized-index revision used by bind CAS. Optional only
   * while dual-reading snapshots written before the spine cutover. */
  revision?: number;
  readonly groupId: string;
  readonly parentTaskId: string;
  readonly pullId: string;
  readonly descriptorDigest: string;
  readonly policy: ForkPolicy;
  readonly deadlineMs: number;
  readonly members: readonly ForkGroupMember[];
  status: ForkGroupStatus;
  /** Why cancellation began; decides the ending when members drain. */
  cancellingCause?: "failure" | "race_winner" | "expiry" | "cancellation";
  /** Set once the breach record commits; breach retries are idempotent. */
  breachedAtMs?: number;
  winner?: { readonly ordinal: number; readonly outcomeDigest: string };
  resolution?: ForkGroupTerminal;
}

/** Idempotency identity for one group opening (REQ-023). */
export function forkGroupKey(
  parentTaskId: string,
  pullId: string,
  descriptorDigest: string,
): string {
  return stableTupleHash(["fork-group", parentTaskId, pullId, descriptorDigest]);
}

export function forkGroupIdFor(parentTaskId: string, pullId: string): string {
  return `${parentTaskId}/${pullId}/group`;
}

/** Result of folding one member terminal into the group. Pure: journal
 *  evidence is appended by the caller from these facts. */
export interface ForkReduction {
  readonly winnerSelected?: { readonly ordinal: number; readonly outcomeDigest: string };
  /** Nonterminal members the policy now requires cancelled. */
  readonly cancelMembers: readonly string[];
  readonly resolution?: ForkGroupTerminal;
}

/** Draft-friendly mutable view used by decision handlers. */
export type DraftForkGroup = { -readonly [K in keyof ForkGroupState]: ForkGroupState[K] };

function biographies(members: readonly ForkGroupMember[]): readonly ForkMemberBiography[] {
  return members
    .filter((member) => member.terminal !== undefined)
    .map((member) => ({
      ordinal: member.ordinal,
      taskId: member.taskId,
      outcome: member.terminal!.outcome,
    }));
}

function resolveDrained(group: ForkGroupState): ForkGroupTerminal {
  const outcomes = biographies(group.members);
  switch (group.cancellingCause) {
    case "expiry":
      return { status: "expired", outcomes };
    case "cancellation":
      return { status: "cancelled", outcomes };
    case "race_winner": {
      const winner = group.winner!;
      const biography = outcomes.find((entry) => entry.ordinal === winner.ordinal)!;
      return {
        status: "completed",
        winnerOrdinal: winner.ordinal,
        // The winning value leads; every biography is present.
        outcomes: [biography, ...outcomes.filter((entry) => entry.ordinal !== winner.ordinal)],
      };
    }
    default:
      break;
  }
  if (group.policy.mode === "race") {
    // All members failed without a winner.
    return {
      status: "failed",
      error: { code: "fork_group_failed", message: "Every race member failed" },
      outcomes,
    };
  }
  // The causal failure leads; cancelled members are usually its victims.
  const failure =
    outcomes.find((entry) => entry.outcome.status === "error") ??
    outcomes.find((entry) => entry.outcome.status !== "ok");
  if (failure === undefined) return { status: "completed", outcomes };
  return {
    status: "failed",
    error:
      failure.outcome.status === "error"
        ? failure.outcome.error
        : { code: "fork_member_cancelled", message: "A fork member was cancelled" },
    outcomes,
  };
}

/**
 * Folds one member terminal into the group (REQ-026 algebra). Mutates the
 * draft group; the caller appends the journal records implied by the
 * returned reduction, in order: RaceWinnerSelected, member cancellations,
 * ForkGroupResolved.
 *
 * First-committed-wins (REQ-032): the reducer observes state at its commit
 * point only. A member terminal arriving after resolution is confined to
 * the member biography; the accepted resolution never changes.
 */
export function reduceForkMemberTerminal(
  group: ForkGroupState,
  taskId: string,
  outcome: OperationOutcome,
): ForkReduction {
  const member = group.members.find((entry) => entry.taskId === taskId);
  if (member === undefined) {
    throw new CrankError("invalid_journal", `Task ${taskId} is not a fork group member`);
  }
  const outcomeDigest = canonicalDigest(outcome);
  if (member.terminal !== undefined) {
    if (member.terminal.outcomeDigest !== outcomeDigest) {
      throw new CrankError("nondeterminism_detected", "Fork member terminal differs");
    }
    return { cancelMembers: [] };
  }
  (member as { terminal?: ForkGroupMember["terminal"] }).terminal = {
    outcome: structuredClone(outcome),
    outcomeDigest,
  };
  group.revision = (group.revision ?? 0) + 1;
  if (group.status === "resolved") {
    // Late biography after an orphaned resolution: confined to member history.
    return { cancelMembers: [] };
  }

  let winnerSelected: ForkReduction["winnerSelected"];
  let cancelMembers: string[] = [];
  if (group.status === "open") {
    if (group.policy.mode === "race" && outcome.status === "ok" && group.winner === undefined) {
      group.winner = { ordinal: member.ordinal, outcomeDigest };
      group.status = "cancelling";
      group.cancellingCause = "race_winner";
      winnerSelected = { ordinal: member.ordinal, outcomeDigest };
      cancelMembers = nonterminalMembers(group);
    } else if (group.policy.mode === "all" && outcome.status !== "ok") {
      group.status = "cancelling";
      group.cancellingCause = outcome.status === "cancelled" ? "cancellation" : "failure";
      cancelMembers = nonterminalMembers(group);
    }
  }

  const base = {
    ...(winnerSelected === undefined ? {} : { winnerSelected }),
    cancelMembers,
  };
  if (group.members.every((entry) => entry.terminal !== undefined)) {
    group.status = "resolved";
    group.resolution = resolveDrained(group);
    return { ...base, resolution: group.resolution };
  }
  return base;
}

function nonterminalMembers(group: ForkGroupState): string[] {
  return group.members
    .filter((member) => member.terminal === undefined)
    .map((member) => member.taskId);
}

/**
 * Resolves the group if every member is terminal (REQ-031: expiry resolves
 * only after cleanup completes). Returns the resolution, or undefined while
 * members remain nonterminal.
 */
export function drainForkGroup(group: ForkGroupState): ForkGroupTerminal | undefined {
  if (group.status === "resolved") return group.resolution;
  if (!group.members.every((member) => member.terminal !== undefined)) return undefined;
  group.status = "resolved";
  group.resolution = resolveDrained(group);
  group.revision = (group.revision ?? 0) + 1;
  return group.resolution;
}

/**
 * Begins cancellation of every nonterminal member (expiry breach or parent
 * cancellation cascade). Returns the member task ids to cancel; the group
 * resolves only when all members are terminal (REQ-031: expiry means breach
 * plus completed cleanup).
 */
export function beginForkGroupCancellation(
  group: ForkGroupState,
  cause: "expiry" | "cancellation",
): readonly string[] {
  if (group.status === "resolved") {
    throw new CrankError("fork_group_terminal", "Fork group already resolved");
  }
  if (group.status === "open") {
    group.status = "cancelling";
    group.cancellingCause = cause;
    group.revision = (group.revision ?? 0) + 1;
  }
  return nonterminalMembers(group);
}

/**
 * Separately authorized force-orphan of a stuck group (REQ-034). Honest:
 * records `orphaned`, never a fabricated ending. Members that later reach
 * terminal are confined to their own biographies.
 */
export function forceOrphanForkGroupResolution(
  group: ForkGroupState,
  reason: string,
): ForkGroupTerminal {
  if (group.status === "resolved") {
    throw new CrankError("fork_group_terminal", "Fork group already resolved");
  }
  group.status = "resolved";
  group.resolution = { status: "orphaned", reason };
  group.revision = (group.revision ?? 0) + 1;
  return group.resolution;
}

/** Maps the terminal algebra onto the outcome transport. The Terminal value
 *  itself is always carried inside (REQ-026: biography as one value). */
export function forkGroupOutcome(terminal: ForkGroupTerminal): OperationOutcome {
  const value = structuredClone(terminal) as Json;
  switch (terminal.status) {
    case "completed":
      return { status: "ok", value };
    case "failed":
      return { status: "error", error: { ...terminal.error, details: value } };
    case "cancelled":
      return { status: "cancelled", partial: value };
    case "expired":
      return {
        status: "error",
        error: {
          code: "fork_group_expired",
          message: "Fork group expired",
          details: value,
        },
      };
    case "orphaned":
      return {
        status: "error",
        error: {
          code: "fork_group_orphaned",
          message: `Fork group orphaned: ${terminal.reason}`,
          details: value,
        },
      };
  }
}
