import { type OperationOutcome } from "@sweatpants/session-contract";

import { CrankError } from "@sweatpants/durable-execution";
import { call, type Operation } from "effection";
import { canonicalJson, canonicalSnapshot, sha256, type Json } from "@sweatpants/session-contract";
import type { ForeignA2AHttpTransport } from "./foreign-client.ts";
import { DELEGATED_EFFECTS_EXTENSION_URI, SWEATPANTS_PEER_PROFILE_URI } from "./peer-types.ts";
import type {
  DelegatedEffectEventPage,
  DelegatedEffectRequestEvent,
  DelegatedEffectResponse,
  DelegatedEffectResponseAck,
  DelegatedEffectStatus,
  PeerCallerFrontiers,
  PeerGrantAmendment,
  PeerGrantAmendmentAck,
  PeerGrantRevocation,
  PeerGrantRevocationAck,
  PeerInvocationPin,
  PeerResolverInput,
} from "./peer-types.ts";

export interface DelegatedEffectsClientPort {
  listEvents(request: {
    pin: PeerInvocationPin;
    taskId: string;
    afterCursor: number;
    pageSize?: number;
  }): Operation<DelegatedEffectEventPage>;
  getEffectStatus(request: {
    pin: PeerInvocationPin;
    taskId: string;
    effectId: string;
  }): Operation<DelegatedEffectStatus>;
  resolveEffect(request: {
    pin: PeerInvocationPin;
    response: DelegatedEffectResponse;
  }): Operation<DelegatedEffectResponseAck>;
  applyAmendment(request: {
    pin: PeerInvocationPin;
    taskId: string;
    amendment: PeerGrantAmendment;
  }): Operation<PeerGrantAmendmentAck>;
  revokeGrant(request: {
    pin: PeerInvocationPin;
    taskId: string;
    revocation: PeerGrantRevocation;
  }): Operation<PeerGrantRevocationAck>;
}

export function createHttpDelegatedEffectsClient(
  transport: ForeignA2AHttpTransport,
): DelegatedEffectsClientPort {
  const invoke = async (
    pin: PeerInvocationPin,
    method: "GET" | "POST",
    path: string,
    body?: Json,
  ): Promise<Json> => {
    const response = await transport.request({
      method,
      url: `${pin.profile.delegatedEffectsEndpoint.replace(/\/$/, "")}/${path}`,
      headers: {
        accept: "application/a2a+json",
        "content-type": "application/a2a+json",
        "A2A-Extensions": `${SWEATPANTS_PEER_PROFILE_URI},${DELEGATED_EFFECTS_EXTENSION_URI}`,
      },
      ...(body !== undefined ? { body } : {}),
      principalId: pin.foreign.principalId,
      ...(pin.foreign.tenantId ? { tenantId: pin.foreign.tenantId } : {}),
    });
    if (response.status < 200 || response.status >= 300 || response.body === undefined) {
      throw new CrankError(
        "peer_transport_error",
        `Delegated-effects operation failed: ${response.status}`,
      );
    }
    const echo = response.headers["a2a-extensions"] ?? response.headers["A2A-Extensions"];
    for (const uri of [SWEATPANTS_PEER_PROFILE_URI, DELEGATED_EFFECTS_EXTENSION_URI]) {
      if (
        !echo
          ?.split(",")
          .map((value) => value.trim())
          .includes(uri)
      ) {
        throw new CrankError(
          "extension_echo_mismatch",
          `Delegated-effects extension not echoed: ${uri}`,
        );
      }
    }
    return response.body;
  };
  return {
    *listEvents(request) {
      const query = new URLSearchParams({
        afterCursor: String(request.afterCursor),
        ...(request.pageSize ? { pageSize: String(request.pageSize) } : {}),
      });
      return (yield* call(() =>
        invoke(request.pin, "GET", `tasks/${encodeURIComponent(request.taskId)}/events?${query}`),
      )) as unknown as DelegatedEffectEventPage;
    },
    *getEffectStatus(request) {
      return (yield* call(() =>
        invoke(
          request.pin,
          "GET",
          `tasks/${encodeURIComponent(request.taskId)}/effects/${encodeURIComponent(request.effectId)}`,
        ),
      )) as unknown as DelegatedEffectStatus;
    },
    *resolveEffect(request) {
      return (yield* call(() =>
        invoke(
          request.pin,
          "POST",
          `tasks/${encodeURIComponent(request.response.taskId)}/effects/${encodeURIComponent(request.response.effectId)}:resolve`,
          request.response as unknown as Json,
        ),
      )) as unknown as DelegatedEffectResponseAck;
    },
    *applyAmendment(request) {
      return (yield* call(() =>
        invoke(
          request.pin,
          "POST",
          `tasks/${encodeURIComponent(request.taskId)}/grants:amend`,
          request.amendment as unknown as Json,
        ),
      )) as unknown as PeerGrantAmendmentAck;
    },
    *revokeGrant(request) {
      return (yield* call(() =>
        invoke(
          request.pin,
          "POST",
          `tasks/${encodeURIComponent(request.taskId)}/grants:revoke`,
          request.revocation as unknown as Json,
        ),
      )) as unknown as PeerGrantRevocationAck;
    },
  };
}

export interface PeerDelegatedEffectCoordinatorOptions {
  readonly pin: PeerInvocationPin;
  readonly taskId: string;
  readonly client: DelegatedEffectsClientPort;
  readonly enforce?: (event: DelegatedEffectRequestEvent) => void;
  readonly onCancelObserved?: (effectId: string) => void;
}

/** Caller-side two-frontier state machine. Returned state must be journaled between methods. */
export class PeerDelegatedEffectCoordinator {
  readonly #pin: PeerInvocationPin;
  readonly #taskId: string;
  readonly #client: DelegatedEffectsClientPort;
  readonly #enforce?: PeerDelegatedEffectCoordinatorOptions["enforce"];
  readonly #onCancelObserved?: PeerDelegatedEffectCoordinatorOptions["onCancelObserved"];

  constructor(options: PeerDelegatedEffectCoordinatorOptions) {
    this.#pin = options.pin;
    this.#taskId = options.taskId;
    this.#client = options.client;
    this.#enforce = options.enforce;
    this.#onCancelObserved = options.onCancelObserved;
  }

  initialState(): PeerCallerFrontiers {
    return {
      observationCursor: 0,
      executionCursor: 0,
      highWatermark: 0,
      queue: [],
      observedDigests: {},
      responseOutbox: [],
      acknowledgedResponses: [],
      revokedGrants: [],
      cancellationRequestedEffects: [],
      grantChainHead: this.#pin.grantSet.digest,
      grantSets: [this.#pin.grantSet],
    };
  }

  *observe(state: PeerCallerFrontiers, pageSize = 100): Operation<PeerCallerFrontiers> {
    const page = yield* this.#client.listEvents({
      pin: this.#pin,
      taskId: this.#taskId,
      afterCursor: state.observationCursor,
      pageSize,
    });
    return this.recordPage(state, page);
  }

  recordPage(state: PeerCallerFrontiers, page: DelegatedEffectEventPage): PeerCallerFrontiers {
    validatePage(page, this.#taskId, state.observationCursor);
    let cursor = state.observationCursor;
    const queue = [...state.queue];
    const observed = { ...state.observedDigests };
    const cancellations = new Set(state.cancellationRequestedEffects);
    for (const event of page.events) {
      if (event.cursor !== cursor + 1) {
        throw new CrankError("peer_event_gap", "Delegated-effect event page contains a cursor gap");
      }
      const previous = observed[event.eventId];
      if (previous && previous !== event.eventDigest) {
        throw new CrankError("peer_event_conflict", "Delegated-effect event identity conflict");
      }
      if (!previous) {
        observed[event.eventId] = event.eventDigest;
        queue.push(event);
      }
      cursor = event.cursor;
      if (event.type === "effect_cancel_requested") {
        cancellations.add(event.effectId);
        this.#onCancelObserved?.(event.effectId);
      }
    }
    return Object.freeze({
      ...state,
      observationCursor: cursor,
      highWatermark: page.highWatermark,
      queue,
      observedDigests: observed,
      cancellationRequestedEffects: [...cancellations],
    });
  }

  *prepareNextResponse(
    state: PeerCallerFrontiers,
    resolve: (
      input: PeerResolverInput,
      event: DelegatedEffectRequestEvent,
    ) => Operation<OperationOutcome>,
  ): Operation<PeerCallerFrontiers> {
    if (
      state.responseOutbox.some(
        (response) => !state.acknowledgedResponses.includes(response.responseId),
      )
    ) {
      return state;
    }
    const event = state.queue.find(
      (candidate): candidate is DelegatedEffectRequestEvent =>
        candidate.type === "effect_requested" && candidate.cursor > state.executionCursor,
    );
    if (!event) {
      return state;
    }
    this.#validateRequest(state, event);
    let outcome: OperationOutcome;
    if (state.cancellationRequestedEffects.includes(event.effectId)) {
      outcome = { status: "cancelled" };
    } else {
      this.#enforce?.(event);
      outcome = yield* resolve(
        {
          invocationId: this.#pin.foreign.invocationId,
          peerTaskId: this.#taskId,
          remoteEffectId: event.effectId,
          grantId: event.grantId,
          grantVersion: event.grantVersion,
          input: event.input,
        },
        event,
      );
    }
    const outcomeDigest = canonicalSnapshot(outcome).sha;
    const responseId = `response_${sha256(
      canonicalJson({
        domain: "sweatpants.peer.effect-response.v1",
        taskId: this.#taskId,
        effectId: event.effectId,
        outcomeDigest,
      }),
    ).slice(0, 40)}`;
    const response: DelegatedEffectResponse = {
      taskId: this.#taskId,
      effectId: event.effectId,
      responseId,
      grantId: event.grantId,
      grantVersion: event.grantVersion,
      contractDigest: event.contractDigest,
      outcome,
      outcomeDigest,
      eventCursor: event.cursor,
    };
    return Object.freeze({
      ...state,
      activeEffectId: event.effectId,
      responseOutbox: [...state.responseOutbox, response],
    });
  }

  *deliverOutbox(state: PeerCallerFrontiers): Operation<PeerCallerFrontiers> {
    let next = state;
    for (const response of state.responseOutbox) {
      if (next.acknowledgedResponses.includes(response.responseId)) {
        continue;
      }
      const status = yield* this.#client.getEffectStatus({
        pin: this.#pin,
        taskId: this.#taskId,
        effectId: response.effectId,
      });
      if (status.status === "expired") {
        throw new CrankError("peer_protocol_expired", "Delegated effect status expired");
      }
      if (status.status === "resolved") {
        if (
          status.response.responseId !== response.responseId ||
          status.response.outcomeDigest !== response.outcomeDigest
        ) {
          throw new CrankError("peer_response_conflict", "Callee recorded another effect response");
        }
      } else {
        const ack = yield* this.#client.resolveEffect({ pin: this.#pin, response });
        if (
          ack.responseId !== response.responseId ||
          ack.outcomeDigest !== response.outcomeDigest
        ) {
          throw new CrankError("peer_response_conflict", "Delegated effect acknowledgment differs");
        }
      }
      const { activeEffectId: _activeEffectId, ...withoutActive } = next;
      next = Object.freeze({
        ...withoutActive,
        executionCursor: Math.max(next.executionCursor, response.eventCursor),
        acknowledgedResponses: [...next.acknowledgedResponses, response.responseId],
      });
    }
    return next;
  }

  *applyAmendment(
    state: PeerCallerFrontiers,
    amendment: PeerGrantAmendment,
  ): Operation<PeerCallerFrontiers> {
    if (
      amendment.previousGrantDigest !== state.grantChainHead ||
      amendment.grantSet.previousDigest !== state.grantChainHead ||
      amendment.grantSet.version !== state.grantSets[state.grantSets.length - 1]!.version + 1
    ) {
      throw new CrankError("peer_grant_amendment_invalid", "Caller grant amendment chain differs");
    }
    const ack = yield* this.#client.applyAmendment({
      pin: this.#pin,
      taskId: this.#taskId,
      amendment,
    });
    if (
      ack.amendmentId !== amendment.amendmentId ||
      ack.grantChainHead !== amendment.grantSet.digest
    ) {
      throw new CrankError(
        "peer_grant_amendment_invalid",
        "Callee amendment acknowledgment differs",
      );
    }
    return Object.freeze({
      ...state,
      grantChainHead: amendment.grantSet.digest,
      grantSets: [...state.grantSets, amendment.grantSet],
    });
  }

  revokeLocally(state: PeerCallerFrontiers, revocation: PeerGrantRevocation): PeerCallerFrontiers {
    const grant = state.grantSets
      .flatMap((grantSet) => grantSet.grants)
      .find(
        (candidate) =>
          candidate.grantId === revocation.grantId &&
          candidate.grantVersion === revocation.grantVersion,
      );
    if (!grant) {
      throw new CrankError("peer_grant_revocation_invalid", "Caller grant is unavailable");
    }
    return Object.freeze({
      ...state,
      revokedGrants: [...new Set([...state.revokedGrants, revocation.grantId])],
    });
  }

  *deliverRevocation(
    state: PeerCallerFrontiers,
    revocation: PeerGrantRevocation,
  ): Operation<PeerGrantRevocationAck> {
    if (!state.revokedGrants.includes(revocation.grantId)) {
      throw new CrankError(
        "peer_grant_revocation_invalid",
        "Grant must be revoked locally before delivery",
      );
    }
    const ack = yield* this.#client.revokeGrant({
      pin: this.#pin,
      taskId: this.#taskId,
      revocation,
    });
    if (
      ack.revocationId !== revocation.revocationId ||
      ack.revocationDigest !== revocation.revocationDigest
    ) {
      throw new CrankError(
        "peer_grant_revocation_invalid",
        "Callee revocation acknowledgment differs",
      );
    }
    return ack;
  }

  diagnostics(state: PeerCallerFrontiers): {
    queueDepth: number;
    activeEffectId?: string;
    executionCursor: number;
    observationCursor: number;
    highWatermark: number;
    nearestRetentionExpiry: string;
  } {
    const pending = state.queue.filter(
      (event) => event.type === "effect_requested" && event.cursor > state.executionCursor,
    );
    const nearest = Object.values(this.#pin.retentionExpiresAt).sort()[0]!;
    return {
      queueDepth: pending.length,
      ...(state.activeEffectId ? { activeEffectId: state.activeEffectId } : {}),
      executionCursor: state.executionCursor,
      observationCursor: state.observationCursor,
      highWatermark: state.highWatermark,
      nearestRetentionExpiry: nearest,
    };
  }

  #validateRequest(state: PeerCallerFrontiers, event: DelegatedEffectRequestEvent): void {
    if (
      event.taskId !== this.#taskId ||
      event.invocationId !== this.#pin.foreign.invocationId ||
      event.route !== "caller" ||
      canonicalSnapshot(event.input).sha !== event.inputDigest
    ) {
      throw new CrankError(
        "peer_effect_request_invalid",
        "Delegated effect request binding differs",
      );
    }
    const grant = state.grantSets
      .flatMap((grantSet) => grantSet.grants)
      .find(
        (candidate) =>
          candidate.grantId === event.grantId && candidate.grantVersion === event.grantVersion,
      );
    if (
      !grant ||
      grant.route !== "caller" ||
      grant.contract.contractDigest !== event.contractDigest ||
      state.revokedGrants.includes(grant.grantId) ||
      Date.now() >= Date.parse(grant.expiresAt)
    ) {
      throw new CrankError("peer_grant_denied", "Delegated effect is not currently authorized");
    }
  }
}

function validatePage(page: DelegatedEffectEventPage, taskId: string, afterCursor: number): void {
  if (page.taskId !== taskId || page.afterCursor !== afterCursor) {
    throw new CrankError("peer_event_page_invalid", "Delegated-effect page frontier differs");
  }
  const { pageDigest, ...body } = page;
  const computed = sha256(canonicalJson({ domain: "sweatpants.peer.event-page.v1", page: body }));
  if (computed !== pageDigest) {
    throw new CrankError("peer_event_page_invalid", "Delegated-effect page digest differs");
  }
  if (afterCursor > 0 && afterCursor < page.retainedFromCursor - 1) {
    throw new CrankError("peer_cursor_expired", "Delegated-effect observation cursor expired");
  }
}

/** Adapts an in-memory or remote promise client to the Effection port. */
export function delegatedEffectsClientFromPromises(input: {
  listEvents: (
    taskId: string,
    afterCursor: number,
    pageSize?: number,
  ) => Promise<DelegatedEffectEventPage>;
  getEffectStatus: (taskId: string, effectId: string) => Promise<DelegatedEffectStatus>;
  resolveEffect: (response: DelegatedEffectResponse) => Promise<DelegatedEffectResponseAck>;
  applyAmendment: (taskId: string, amendment: PeerGrantAmendment) => Promise<PeerGrantAmendmentAck>;
  revokeGrant: (taskId: string, revocation: PeerGrantRevocation) => Promise<PeerGrantRevocationAck>;
}): DelegatedEffectsClientPort {
  return {
    *listEvents(request) {
      return yield* call(() =>
        input.listEvents(request.taskId, request.afterCursor, request.pageSize),
      );
    },
    *getEffectStatus(request) {
      return yield* call(() => input.getEffectStatus(request.taskId, request.effectId));
    },
    *resolveEffect(request) {
      return yield* call(() => input.resolveEffect(request.response));
    },
    *applyAmendment(request) {
      return yield* call(() => input.applyAmendment(request.taskId, request.amendment));
    },
    *revokeGrant(request) {
      return yield* call(() => input.revokeGrant(request.taskId, request.revocation));
    },
  };
}
