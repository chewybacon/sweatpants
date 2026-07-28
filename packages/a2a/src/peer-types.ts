import { type OperationOutcome, type RetrySafety } from "@sweatpants/session-contract";

import type { PortableSchemaDescriptor, Json } from "@sweatpants/session-contract";
import type { ForeignA2AInvocationPin, ForeignA2ATerminalResult } from "./foreign-task-types.ts";

export const SWEATPANTS_PEER_PROFILE_URI =
  "https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/sweatpants-peer/v1/spec.md";
export const DELEGATED_EFFECTS_EXTENSION_URI =
  "https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/delegated-effects/v1/spec.md";

export type PeerEffectAvailability =
  | "callee_local_only"
  | "caller_required"
  | "caller_optional"
  | "route_negotiable";
export type PeerEffectRoute = "callee" | "caller" | "denied";
export type PeerDelegationRule =
  | { readonly mode: "none" }
  | {
      readonly mode: "transitive";
      readonly maxDepth: number;
      readonly allowedAgents: string[];
      readonly allowedContractDigests: string[];
    };

export type PeerEffectContract = {
  readonly name: string;
  readonly version: string;
  readonly inputSchema: PortableSchemaDescriptor;
  readonly outputSchema: PortableSchemaDescriptor;
  readonly cancellation?: { readonly partialSchema: PortableSchemaDescriptor };
  readonly retrySafety: RetrySafety;
  readonly contractDigest: string;
};
export type PeerEffectRequirement = {
  readonly contract: PeerEffectContract;
  readonly availability: PeerEffectAvailability;
  readonly required: boolean;
  readonly allowedRoutes: PeerEffectRoute[];
  readonly defaultConstraints?: Json;
  readonly defaultBudget?: Json;
};
export type PeerEffectRequirementManifest = {
  readonly protocolVersion: 1;
  readonly skillId: string;
  readonly requirements: PeerEffectRequirement[];
  readonly amendmentRequests: boolean;
  readonly releaseDigest: string;
  readonly manifestDigest: string;
};

export type PeerEffectOffer = {
  readonly contractDigest: string;
  readonly route: PeerEffectRoute;
  readonly constraints?: Json;
  readonly budget?: Json;
  readonly delegation: PeerDelegationRule;
};
export type PeerOffer = {
  readonly protocolVersion: 1;
  readonly skillId: string;
  readonly requirementManifestDigest: string;
  readonly effects: PeerEffectOffer[];
  readonly amendmentRequests: boolean;
  readonly lineage?: string[];
};
export type PeerGrant = {
  readonly grantId: string;
  readonly grantVersion: number;
  readonly contract: PeerEffectContract;
  readonly route: PeerEffectRoute;
  readonly constraints?: Json;
  readonly budget?: Json;
  readonly expiresAt: string;
  readonly delegation: PeerDelegationRule;
  readonly callerIdentity: string;
  readonly calleeIdentity: string;
  readonly invocationId: string;
  readonly peerTaskId?: string;
};
export type PeerGrantSet = {
  readonly protocolVersion: 1;
  readonly version: number;
  readonly previousDigest?: string;
  readonly requirementManifestDigest: string;
  readonly grants: PeerGrant[];
  readonly amendmentRequests: boolean;
  readonly digest: string;
};

export type PeerRetentionV1 = {
  readonly taskSeconds: number;
  readonly invocationBindingSeconds: number;
  readonly effectEventSeconds: number;
  readonly grantSeconds: number;
  readonly effectResponseSeconds: number;
  readonly cancellationEvidenceSeconds: number;
  readonly terminalEvidenceSeconds: number;
};
export type SweatpantsPeerProfileParamsV1 = {
  readonly protocolVersion: 1;
  readonly delegatedEffectsVersion: 1;
  readonly requirementManifestEndpoint: string;
  readonly delegatedEffectsEndpoint: string;
  readonly retention: PeerRetentionV1;
  readonly terminalEvidenceKeyId?: string;
};
export type PeerInvocationPin = {
  readonly foreign: ForeignA2AInvocationPin;
  readonly calleeIdentity: string;
  readonly requirementManifest: PeerEffectRequirementManifest;
  readonly grantSet: PeerGrantSet;
  readonly profile: SweatpantsPeerProfileParamsV1;
  readonly retentionExpiresAt: Record<keyof PeerRetentionV1, string>;
};

export type DelegatedEffectRequestEvent = {
  readonly type: "effect_requested";
  readonly eventId: string;
  readonly cursor: number;
  readonly taskId: string;
  readonly invocationId: string;
  readonly effectId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly contractDigest: string;
  readonly input: Json;
  readonly inputDigest: string;
  readonly route: "caller";
  readonly cancellationState: "none" | "requested";
  readonly eventDigest: string;
};
export type DelegatedEffectCancelEvent = {
  readonly type: "effect_cancel_requested";
  readonly eventId: string;
  readonly cursor: number;
  readonly taskId: string;
  readonly invocationId: string;
  readonly effectId: string;
  readonly reason?: string;
  readonly eventDigest: string;
};
export type PeerGrantAmendmentRequestEvent = {
  readonly type: "grant_amendment_requested";
  readonly eventId: string;
  readonly cursor: number;
  readonly taskId: string;
  readonly invocationId: string;
  readonly amendmentId: string;
  readonly purpose: string;
  readonly requested: PeerEffectOffer[];
  readonly eventDigest: string;
};
export type PeerRetentionRenewedEvent = {
  readonly type: "retention_renewed";
  readonly eventId: string;
  readonly cursor: number;
  readonly taskId: string;
  readonly invocationId: string;
  readonly expirations: Record<keyof PeerRetentionV1, string>;
  readonly eventDigest: string;
};
export type PeerTerminalEvent = {
  readonly type: "task_terminal";
  readonly eventId: string;
  readonly cursor: number;
  readonly taskId: string;
  readonly invocationId: string;
  readonly result: ForeignA2ATerminalResult;
  readonly evidence?: PeerTerminalEvidence;
  readonly eventDigest: string;
};
export type DelegatedEffectEvent =
  | DelegatedEffectRequestEvent
  | DelegatedEffectCancelEvent
  | PeerGrantAmendmentRequestEvent
  | PeerRetentionRenewedEvent
  | PeerTerminalEvent;
export type DelegatedEffectEventPage = {
  readonly taskId: string;
  readonly afterCursor: number;
  readonly events: DelegatedEffectEvent[];
  readonly highWatermark: number;
  readonly retainedFromCursor: number;
  readonly expiresAt: string;
  readonly pageDigest: string;
};

export type DelegatedEffectResponse = {
  readonly taskId: string;
  readonly effectId: string;
  readonly responseId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly contractDigest: string;
  readonly outcome: OperationOutcome;
  readonly outcomeDigest: string;
  readonly eventCursor: number;
};
export type DelegatedEffectStatus =
  | { readonly status: "pending"; readonly cancellationRequested: boolean }
  | { readonly status: "resolved"; readonly response: DelegatedEffectResponse }
  | { readonly status: "expired" };
export type DelegatedEffectResponseAck = {
  readonly status: "accepted" | "duplicate";
  readonly responseId: string;
  readonly outcomeDigest: string;
};
export type PeerGrantAmendment = {
  readonly amendmentId: string;
  readonly previousGrantDigest: string;
  readonly grantSet: PeerGrantSet;
};
export type PeerGrantAmendmentAck = {
  readonly status: "accepted" | "duplicate";
  readonly amendmentId: string;
  readonly grantChainHead: string;
};
export type PeerGrantRevocation = {
  readonly revocationId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly revocationDigest: string;
  readonly reason?: string;
};
export type PeerGrantRevocationAck = {
  readonly status: "accepted" | "duplicate";
  readonly revocationId: string;
  readonly revocationDigest: string;
};

export type PeerCallerFrontiers = {
  readonly observationCursor: number;
  readonly executionCursor: number;
  readonly highWatermark: number;
  readonly activeEffectId?: string;
  readonly queue: DelegatedEffectEvent[];
  readonly observedDigests: Record<string, string>;
  readonly responseOutbox: DelegatedEffectResponse[];
  readonly acknowledgedResponses: string[];
  readonly revokedGrants: string[];
  readonly cancellationRequestedEffects: string[];
  readonly grantChainHead: string;
  readonly grantSets: PeerGrantSet[];
};
export type PeerTerminalEvidence = {
  readonly taskId: string;
  readonly calleeReleaseDigest: string;
  readonly protocolVersion: 1;
  readonly terminalState: string;
  readonly resultDigest: string;
  readonly grantChainHead: string;
  readonly delegatedEffectTranscriptHead: string;
  readonly calleeJournalRoot: string;
  readonly keyId?: string;
  readonly signature?: string;
};

export type PeerResolverInput = {
  readonly invocationId: string;
  readonly peerTaskId: string;
  readonly remoteEffectId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly input: Json;
};
export type PeerResolverOutput = OperationOutcome;
