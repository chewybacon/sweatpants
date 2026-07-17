import type { Json } from "@sweatpants/session-contract";

export const DURABLE_INVOCATION_EXTENSION_URI =
  "https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/durable-invocation/v1/spec.md";

export type ForeignA2AGuarantee =
  | "reconciled"
  | "idempotent_messages"
  | "task_handle_only"
  | "best_effort";
export type ForeignA2AAmbiguityPolicy = "surface" | "intervene" | "retry_may_duplicate";
export type ForeignA2ANormalizedState =
  | "submitted"
  | "working"
  | "input_required"
  | "auth_required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";
export type ForeignA2ATerminalState = Extract<
  ForeignA2ANormalizedState,
  "completed" | "failed" | "canceled" | "rejected"
>;

export type ForeignA2APart = {
  readonly text?: string;
  readonly raw?: string;
  readonly url?: string;
  readonly data?: Json;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly metadata?: Json;
};
export type ForeignA2AMessage = {
  readonly messageId: string;
  readonly role: "user" | "agent";
  readonly parts: ForeignA2APart[];
  readonly taskId?: string;
  readonly contextId?: string;
  readonly metadata?: Json;
  readonly extensions?: string[];
};
export type ForeignA2AArtifact = {
  readonly artifactId: string;
  readonly name?: string;
  readonly description?: string;
  readonly parts: ForeignA2APart[];
  readonly metadata?: Json;
};
export type ForeignA2ATaskStatus = {
  readonly state: ForeignA2ANormalizedState;
  readonly message?: ForeignA2AMessage;
  readonly timestamp?: string;
};
export type ForeignA2ATask = {
  readonly id: string;
  readonly contextId?: string;
  readonly status: ForeignA2ATaskStatus;
  readonly artifacts: ForeignA2AArtifact[];
  readonly history?: ForeignA2AMessage[];
  readonly metadata?: Json;
};
export type ForeignA2ASendResult =
  | { readonly type: "task"; readonly task: ForeignA2ATask }
  | { readonly type: "message"; readonly message: ForeignA2AMessage };

export type ForeignA2ARetentionV1 = {
  readonly invocationBindingSeconds: number;
  readonly abortTombstoneSeconds: number;
  readonly messageIdempotencySeconds: number;
  readonly taskSeconds: number;
  readonly terminalResultSeconds: number;
  readonly clockSkewSeconds: number;
};
export type DurableInvocationExtensionParamsV1 = {
  readonly protocolVersion: 1;
  readonly resolveEndpoint: string;
  readonly abortEndpoint: string;
  readonly retention: ForeignA2ARetentionV1;
  readonly messageIdempotency: true;
};

export type ForeignA2AInterfacePin = {
  readonly url: string;
  readonly protocolBinding: "HTTP+JSON" | "JSONRPC" | "GRPC";
  readonly protocolVersion: string;
  readonly tenant?: string;
};
export type ForeignA2AGuaranteePin = {
  readonly level: ForeignA2AGuarantee;
  readonly source:
    | "durable_invocation_extension"
    | "idempotency_extension"
    | "operator_attestation"
    | "base_task_handle"
    | "base_best_effort";
  readonly negotiatedAt: string;
  readonly invocationExpiresAt?: string;
  readonly messageIdempotencyExpiresAt?: string;
  readonly taskExpiresAt?: string;
  readonly terminalResultExpiresAt?: string;
  readonly abortTombstoneExpiresAt?: string;
  readonly extension?: DurableInvocationExtensionParamsV1;
};
export type ForeignA2AInvocationPin = {
  readonly cardDigest: string;
  readonly agentName: string;
  readonly skillId: string;
  readonly interface: ForeignA2AInterfacePin;
  readonly extensionUris: string[];
  readonly guarantee: ForeignA2AGuaranteePin;
  readonly ambiguityPolicy: ForeignA2AAmbiguityPolicy;
  readonly duplicateRiskAcknowledged?: true;
  readonly invocationId: string;
  readonly initialMessageId: string;
  readonly requestExpiresAt: string;
  readonly principalId: string;
  readonly tenantId?: string;
};

export type ForeignA2AStartRequest = {
  readonly pin: ForeignA2AInvocationPin;
  readonly message: ForeignA2AMessage;
  readonly acceptedOutputModes?: string[];
  readonly maxDispatchAttempts?: number;
};
export type ForeignA2AContinueRequest = {
  readonly pin: ForeignA2AInvocationPin;
  readonly taskId: string;
  readonly contextId?: string;
  readonly message: ForeignA2AMessage;
  readonly messageIdempotencyExpiresAt?: string;
  readonly maxDispatchAttempts?: number;
};

export type ForeignA2AInterruption =
  | {
      readonly type: "input_required";
      readonly taskId: string;
      readonly contextId?: string;
      readonly request: ForeignA2AMessage;
      readonly requestDigest: string;
      readonly extensionMetadata?: Json;
    }
  | {
      readonly type: "auth_required";
      readonly taskId: string;
      readonly contextId?: string;
      readonly request?: ForeignA2AMessage;
      readonly requestDigest?: string;
      readonly extensionMetadata?: Json;
    };

export type ForeignA2AIndeterminatePhase =
  | "initial_dispatch"
  | "continuation_dispatch"
  | "observation"
  | "cancellation"
  | "reconciliation";
export type ForeignA2AIndeterminate = {
  readonly type: "indeterminate";
  readonly phase: ForeignA2AIndeterminatePhase;
  readonly invocationId: string;
  readonly messageId: string;
  readonly remoteTaskMayExist: boolean;
  readonly taskId?: string;
  readonly contextId?: string;
  readonly lastConfirmedState?: ForeignA2ANormalizedState;
  readonly code: string;
  readonly message: string;
};

export type ForeignA2ASessionEvent =
  | { readonly type: "progress"; readonly task: ForeignA2ATask; readonly digest: string }
  | { readonly type: "interruption"; readonly interruption: ForeignA2AInterruption }
  | { readonly type: "terminal"; readonly result: ForeignA2ATerminalResult }
  | { readonly type: "indeterminate"; readonly result: ForeignA2AIndeterminate };

export type ForeignA2ATerminalResult =
  | {
      readonly status: "completed";
      readonly guarantee: ForeignA2AGuaranteePin;
      readonly taskId?: string;
      readonly contextId?: string;
      readonly task?: ForeignA2ATask;
      readonly message?: ForeignA2AMessage;
      readonly artifacts: ForeignA2AArtifact[];
    }
  | {
      readonly status: "failed" | "canceled" | "rejected";
      readonly guarantee: ForeignA2AGuaranteePin;
      readonly taskId: string;
      readonly contextId?: string;
      readonly task: ForeignA2ATask;
      readonly artifacts: ForeignA2AArtifact[];
    }
  | ({ readonly status: "indeterminate" } & Omit<ForeignA2AIndeterminate, "type"> & {
        readonly guarantee: ForeignA2AGuaranteePin;
      })
  | {
      readonly status: "abandoned";
      readonly guarantee: ForeignA2AGuaranteePin;
      readonly taskId?: string;
      readonly contextId?: string;
      readonly reason: string;
    }
  | {
      readonly status: "remote_state_expired";
      readonly guarantee: ForeignA2AGuaranteePin;
      readonly taskId?: string;
      readonly contextId?: string;
    }
  | {
      readonly status: "interrupted";
      readonly guarantee: ForeignA2AGuaranteePin;
      readonly interruption: ForeignA2AInterruption;
      readonly task: ForeignA2ATask;
    };

export type ForeignA2ACancelResult =
  | { readonly status: "confirmed_canceled"; readonly task: ForeignA2ATask }
  | { readonly status: "definitely_not_created"; readonly abortExpiresAt: string }
  | { readonly status: "not_created_at_reconciliation_time" }
  | { readonly status: "already_terminal"; readonly task: ForeignA2ATask }
  | { readonly status: "not_cancelable" | "rejected"; readonly task?: ForeignA2ATask }
  | { readonly status: "task_not_found_or_expired" }
  | { readonly status: "transport_indeterminate" | "creation_indeterminate" };

export type ForeignA2AObservationState = {
  readonly pin: ForeignA2AInvocationPin;
  readonly binding?: { readonly taskId: string; readonly contextId?: string };
  readonly lastTask?: ForeignA2ATask;
  readonly observationDigests: Record<string, string>;
  readonly initialMessageDigest: string;
  readonly continuationIndex: number;
};

export type ForeignA2AOperatorDecision = {
  readonly action:
    | "keep_waiting"
    | "bind_task"
    | "abandon"
    | "confirm_outcome"
    | "retry_may_duplicate";
  readonly taskId?: string;
  readonly acknowledgedDuplicateRisk?: boolean;
  readonly outcome?: ForeignA2ATerminalResult;
};
