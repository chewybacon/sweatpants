import {
  CrankError,
  canonicalJson,
  canonicalSnapshot,
  sha256,
  type Json,
  type OperationOutcome,
} from "@sweatpants/session-contract";
import type {
  DelegatedEffectEvent,
  DelegatedEffectEventPage,
  DelegatedEffectRequestEvent,
  DelegatedEffectResponse,
  DelegatedEffectResponseAck,
  DelegatedEffectStatus,
  PeerGrantAmendment,
  PeerGrantAmendmentAck,
  PeerGrantRevocation,
  PeerGrantRevocationAck,
  PeerEffectOffer,
  PeerGrantSet,
  PeerRetentionV1,
  PeerTerminalEvidence,
} from "./peer-types.ts";
import type { ForeignA2ATerminalResult } from "./foreign-task-types.ts";

const INLINE_LIMIT = 1024 * 1024;
const PAGE_LIMIT = 2 * 1024 * 1024;

type DelegatedEffectEventBody = DelegatedEffectEvent extends infer Event
  ? Event extends DelegatedEffectEvent
    ? Omit<Event, "eventId" | "cursor" | "eventDigest">
    : never
  : never;

type EffectRecord = {
  request: DelegatedEffectRequestEvent;
  response?: DelegatedEffectResponse;
  cancellationRequested: boolean;
};
type TaskRecord = {
  taskId: string;
  invocationId: string;
  callerIdentity: string;
  calleeIdentity: string;
  grants: PeerGrantSet;
  events: DelegatedEffectEvent[];
  effects: Map<string, EffectRecord>;
  revoked: Set<string>;
  amendmentAcks: Map<string, { digest: string; ack: PeerGrantAmendmentAck }>;
  revocationAcks: Map<string, { digest: string; ack: PeerGrantRevocationAck }>;
  responseAcks: Map<string, { digest: string; ack: DelegatedEffectResponseAck }>;
  terminal?: PeerTerminalEvidence;
  expiresAt: number;
};

export interface DelegatedEffectsServiceOptions {
  readonly retention: PeerRetentionV1;
  readonly now?: () => number;
  readonly validateOutcome?: (taskId: string, effectId: string, outcome: OperationOutcome) => void;
}

/** Callee-side journal projection for the delegated-effect event/outbox protocol. */
export class InMemoryDelegatedEffectsService {
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #retention: PeerRetentionV1;
  readonly #now: () => number;
  readonly #validateOutcome?: DelegatedEffectsServiceOptions["validateOutcome"];

  constructor(options: DelegatedEffectsServiceOptions) {
    validateRetention(options.retention);
    this.#retention = { ...options.retention };
    this.#now = options.now ?? Date.now;
    this.#validateOutcome = options.validateOutcome;
  }

  createTask(input: {
    taskId: string;
    invocationId: string;
    callerIdentity: string;
    calleeIdentity: string;
    grantSet: PeerGrantSet;
  }): void {
    if (this.#tasks.has(input.taskId)) {
      const previous = this.#tasks.get(input.taskId)!;
      if (
        previous.invocationId !== input.invocationId ||
        previous.grants.digest !== input.grantSet.digest
      ) {
        throw new CrankError("peer_task_conflict", "Peer task identity was reused inconsistently");
      }
      return;
    }
    this.#tasks.set(input.taskId, {
      taskId: input.taskId,
      invocationId: input.invocationId,
      callerIdentity: input.callerIdentity,
      calleeIdentity: input.calleeIdentity,
      grants: input.grantSet,
      events: [],
      effects: new Map(),
      revoked: new Set(),
      amendmentAcks: new Map(),
      revocationAcks: new Map(),
      responseAcks: new Map(),
      expiresAt: this.#now() + this.#retention.effectEventSeconds * 1_000,
    });
  }

  appendEffectRequest(input: {
    taskId: string;
    effectId: string;
    grantId: string;
    grantVersion: number;
    contractDigest: string;
    value: Json;
  }): DelegatedEffectRequestEvent {
    const task = this.#task(input.taskId);
    const previous = task.effects.get(input.effectId);
    const inputDigest = boundedDigest(input.value, INLINE_LIMIT, "delegated effect input");
    if (previous) {
      if (
        previous.request.inputDigest !== inputDigest ||
        previous.request.grantId !== input.grantId ||
        previous.request.contractDigest !== input.contractDigest
      ) {
        throw new CrankError(
          "peer_event_conflict",
          "Delegated effect ID was reused inconsistently",
        );
      }
      return previous.request;
    }
    const grant = task.grants.grants.find(
      (candidate) =>
        candidate.grantId === input.grantId && candidate.grantVersion === input.grantVersion,
    );
    if (
      !grant ||
      grant.route !== "caller" ||
      grant.contract.contractDigest !== input.contractDigest
    ) {
      throw new CrankError("peer_grant_denied", "Delegated effect is not covered by the grant");
    }
    if (task.revoked.has(grant.grantId)) {
      throw new CrankError("peer_grant_revoked", "Delegated effect grant was revoked");
    }
    if (Date.now() >= Date.parse(grant.expiresAt)) {
      throw new CrankError("peer_grant_expired", "Delegated effect grant expired");
    }
    const event = this.#event(task, {
      type: "effect_requested",
      taskId: task.taskId,
      invocationId: task.invocationId,
      effectId: input.effectId,
      grantId: input.grantId,
      grantVersion: input.grantVersion,
      contractDigest: input.contractDigest,
      input: canonicalSnapshot(input.value).value,
      inputDigest,
      route: "caller",
      cancellationState: "none",
    }) as DelegatedEffectRequestEvent;
    task.effects.set(input.effectId, { request: event, cancellationRequested: false });
    return event;
  }

  appendGrantAmendmentRequest(input: {
    taskId: string;
    amendmentId: string;
    purpose: string;
    requested: PeerEffectOffer[];
  }): DelegatedEffectEvent {
    const task = this.#task(input.taskId);
    if (!task.grants.amendmentRequests) {
      throw new CrankError(
        "peer_grant_amendment_denied",
        "This peer invocation does not permit grant amendments",
      );
    }
    return this.#event(task, {
      type: "grant_amendment_requested",
      taskId: task.taskId,
      invocationId: task.invocationId,
      amendmentId: input.amendmentId,
      purpose: input.purpose,
      requested: canonicalSnapshot(input.requested).value as PeerEffectOffer[],
    });
  }

  renewRetention(
    taskId: string,
    expirations: Record<keyof PeerRetentionV1, string>,
  ): DelegatedEffectEvent {
    const task = this.#task(taskId);
    for (const value of Object.values(expirations)) {
      if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= this.#now()) {
        throw new CrankError(
          "peer_retention_invalid",
          "Peer retention renewal is not future-dated",
        );
      }
    }
    task.expiresAt = Date.parse(expirations.effectEventSeconds);
    return this.#event(task, {
      type: "retention_renewed",
      taskId: task.taskId,
      invocationId: task.invocationId,
      expirations,
    });
  }

  appendTerminal(
    taskId: string,
    result: ForeignA2ATerminalResult,
    evidence?: PeerTerminalEvidence,
  ): DelegatedEffectEvent {
    const task = this.#task(taskId);
    if (task.terminal) {
      if (evidence && canonicalJson(task.terminal) !== canonicalJson(evidence)) {
        throw new CrankError("peer_terminal_conflict", "Terminal peer evidence is immutable");
      }
      return task.events.find((event) => event.type === "task_terminal")!;
    }
    if (evidence) {
      task.terminal = evidence;
    }
    return this.#event(task, {
      type: "task_terminal",
      taskId: task.taskId,
      invocationId: task.invocationId,
      result,
      ...(evidence ? { evidence } : {}),
    });
  }

  appendEffectCancellation(input: {
    taskId: string;
    effectId: string;
    cancelId: string;
    reason?: string;
  }): DelegatedEffectEvent {
    const task = this.#task(input.taskId);
    const effect = task.effects.get(input.effectId);
    if (!effect) {
      throw new CrankError("peer_effect_not_found", "Delegated effect is unavailable");
    }
    const existing = task.events.find((event) => event.eventId === input.cancelId);
    if (existing) {
      return existing;
    }
    effect.cancellationRequested = true;
    return this.#event(task, {
      type: "effect_cancel_requested",
      taskId: task.taskId,
      invocationId: task.invocationId,
      effectId: input.effectId,
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  listEvents(taskId: string, afterCursor: number, pageSize = 100): DelegatedEffectEventPage {
    const task = this.#task(taskId);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new CrankError("peer_cursor_invalid", "Delegated-effect cursor is invalid");
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
      throw new CrankError("peer_page_invalid", "Delegated-effect page size is invalid");
    }
    const events = task.events.filter((event) => event.cursor > afterCursor).slice(0, pageSize);
    if (events.length > 0 && events[0]!.cursor !== afterCursor + 1) {
      throw new CrankError("peer_cursor_expired", "Delegated-effect event cursor is unavailable");
    }
    const body = {
      taskId,
      afterCursor,
      events,
      highWatermark: task.events.length,
      retainedFromCursor: 1,
      expiresAt: new Date(task.expiresAt).toISOString(),
    };
    const page = {
      ...body,
      pageDigest: sha256(canonicalJson({ domain: "sweatpants.peer.event-page.v1", page: body })),
    };
    boundedDigest(page as unknown as Json, PAGE_LIMIT, "delegated effect event page");
    return page;
  }

  getEffectStatus(taskId: string, effectId: string): DelegatedEffectStatus {
    const task = this.#task(taskId);
    const effect = task.effects.get(effectId);
    if (!effect) {
      return { status: "expired" };
    }
    return effect.response
      ? { status: "resolved", response: effect.response }
      : { status: "pending", cancellationRequested: effect.cancellationRequested };
  }

  resolveEffect(response: DelegatedEffectResponse): DelegatedEffectResponseAck {
    const task = this.#task(response.taskId);
    const effect = task.effects.get(response.effectId);
    if (!effect) {
      throw new CrankError("peer_effect_not_found", "Delegated effect is unavailable");
    }
    const digest = boundedDigest(
      response as unknown as Json,
      INLINE_LIMIT,
      "delegated effect response",
    );
    const previous = task.responseAcks.get(response.responseId);
    if (previous) {
      if (previous.digest !== digest) {
        throw new CrankError("idempotency_conflict", "Delegated effect response identity conflict");
      }
      return { ...previous.ack, status: "duplicate" };
    }
    if (
      effect.request.grantId !== response.grantId ||
      effect.request.grantVersion !== response.grantVersion ||
      effect.request.contractDigest !== response.contractDigest ||
      canonicalSnapshot(response.outcome).sha !== response.outcomeDigest
    ) {
      throw new CrankError(
        "peer_effect_response_invalid",
        "Delegated effect response binding differs",
      );
    }
    this.#validateOutcome?.(response.taskId, response.effectId, response.outcome);
    effect.response = canonicalSnapshot(response).value as DelegatedEffectResponse;
    const ack: DelegatedEffectResponseAck = {
      status: "accepted",
      responseId: response.responseId,
      outcomeDigest: response.outcomeDigest,
    };
    task.responseAcks.set(response.responseId, { digest, ack });
    return ack;
  }

  applyAmendment(taskId: string, amendment: PeerGrantAmendment): PeerGrantAmendmentAck {
    const task = this.#task(taskId);
    const digest = boundedDigest(amendment as unknown as Json, INLINE_LIMIT, "grant amendment");
    const previous = task.amendmentAcks.get(amendment.amendmentId);
    if (previous) {
      if (previous.digest !== digest) {
        throw new CrankError("idempotency_conflict", "Grant amendment conflict");
      }
      return { ...previous.ack, status: "duplicate" };
    }
    if (
      !task.grants.amendmentRequests ||
      amendment.previousGrantDigest !== task.grants.digest ||
      amendment.grantSet.previousDigest !== task.grants.digest ||
      amendment.grantSet.version !== task.grants.version + 1
    ) {
      throw new CrankError("peer_grant_amendment_invalid", "Grant amendment chain is invalid");
    }
    task.grants = amendment.grantSet;
    const ack: PeerGrantAmendmentAck = {
      status: "accepted",
      amendmentId: amendment.amendmentId,
      grantChainHead: amendment.grantSet.digest,
    };
    task.amendmentAcks.set(amendment.amendmentId, { digest, ack });
    return ack;
  }

  revokeGrant(taskId: string, revocation: PeerGrantRevocation): PeerGrantRevocationAck {
    const task = this.#task(taskId);
    const digest = boundedDigest(revocation as unknown as Json, INLINE_LIMIT, "grant revocation");
    const previous = task.revocationAcks.get(revocation.revocationId);
    if (previous) {
      if (previous.digest !== digest) {
        throw new CrankError("idempotency_conflict", "Grant revocation conflict");
      }
      return { ...previous.ack, status: "duplicate" };
    }
    const grant = task.grants.grants.find(
      (candidate) =>
        candidate.grantId === revocation.grantId &&
        candidate.grantVersion === revocation.grantVersion,
    );
    if (
      !grant ||
      canonicalSnapshot({
        revocationId: revocation.revocationId,
        grantId: revocation.grantId,
        grantVersion: revocation.grantVersion,
        ...(revocation.reason ? { reason: revocation.reason } : {}),
      }).sha !== revocation.revocationDigest
    ) {
      throw new CrankError("peer_grant_revocation_invalid", "Grant revocation is invalid");
    }
    task.revoked.add(revocation.grantId);
    const ack: PeerGrantRevocationAck = {
      status: "accepted",
      revocationId: revocation.revocationId,
      revocationDigest: revocation.revocationDigest,
    };
    task.revocationAcks.set(revocation.revocationId, { digest, ack });
    return ack;
  }

  taskProjection(taskId: string): Json {
    const task = this.#task(taskId);
    const terminal = task.events.find((event) => event.type === "task_terminal");
    if (terminal?.type === "task_terminal") {
      const state =
        terminal.result.status === "completed"
          ? "TASK_STATE_COMPLETED"
          : terminal.result.status === "canceled"
            ? "TASK_STATE_CANCELED"
            : terminal.result.status === "rejected"
              ? "TASK_STATE_REJECTED"
              : "TASK_STATE_FAILED";
      return {
        id: task.taskId,
        status: { state },
        metadata: {
          grantChainHead: task.grants.digest,
          terminalEvidence: terminal.evidence ?? null,
        },
      };
    }
    const pending = [...task.effects.values()].find((effect) => !effect.response);
    return pending
      ? {
          id: task.taskId,
          status: {
            state: "TASK_STATE_INPUT_REQUIRED",
            message: {
              messageId: `peer-status-${task.events.length}`,
              role: "ROLE_AGENT",
              parts: [{ text: "This peer task awaits delegated-effect or grant resolution." }],
              extensions: [
                "https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/delegated-effects/v1/spec.md",
              ],
              metadata: {
                reason: "delegated_effect",
                eventCursor: task.events.length,
              },
            },
          },
        }
      : { id: task.taskId, status: { state: "TASK_STATE_WORKING" } };
  }

  #event(task: TaskRecord, body: DelegatedEffectEventBody): DelegatedEffectEvent {
    const cursor = task.events.length + 1;
    const identity = { ...body, cursor };
    const eventId = `event_${sha256(canonicalJson(identity)).slice(0, 40)}`;
    const event = {
      ...identity,
      eventId,
      eventDigest: sha256(
        canonicalJson({
          domain: "sweatpants.peer.delegated-event.v1",
          event: { ...identity, eventId },
        }),
      ),
    } as DelegatedEffectEvent;
    task.events.push(event);
    return event;
  }

  #task(taskId: string): TaskRecord {
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new CrankError("peer_task_expired", "Peer task protocol state is unavailable");
    }
    if (this.#now() >= task.expiresAt) {
      throw new CrankError("peer_protocol_expired", "Peer delegated-effect retention expired");
    }
    return task;
  }
}

function boundedDigest(value: Json, limit: number, label: string): string {
  const snapshot = canonicalSnapshot(value);
  if (new TextEncoder().encode(snapshot.canonical).byteLength > limit) {
    throw new CrankError("payload_too_large", `${label} exceeds its inline bound`);
  }
  return snapshot.sha;
}
function validateRetention(retention: PeerRetentionV1): void {
  for (const [name, value] of Object.entries(retention)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CrankError("invalid_descriptor", `Invalid peer retention ${name}`);
    }
  }
}
