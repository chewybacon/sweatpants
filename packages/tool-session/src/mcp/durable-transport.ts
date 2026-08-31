import { CrankError } from "@sweatpants/durable-execution";
import { canonicalSnapshot, stableTupleHash, type Json } from "@sweatpants/foundation";
import type { ResolutionReceipt } from "@sweatpants/durable-execution";

/** MCP extension identifier for durable effect authorization and commit. */
export const MCP_DURABLE_EFFECTS_EXTENSION = "sweatpants.chat/durable-effects-v1";
/** MRTR request type for durable pull authorization. */
export const MCP_DURABLE_AUTHORIZE_REQUEST = "sweatpants.chat/durable-effects/authorize";
/** MRTR request type for committing a durable pull outcome. */
export const MCP_DURABLE_COMMIT_REQUEST = "sweatpants.chat/durable-effects/commit";
/** Default encrypted MCP request-state plaintext limit. */
export const MCP_REQUEST_STATE_MAX_BYTES = 1024 * 1024;

/** Effective tool durability exposed by the negotiated transport boundary. */
export type ToolDurability = "opaque" | "crank_native";

/** Parsed MCP capability metadata used to classify effective durability. */
export interface McpToolDurabilityMetadata {
  negotiatedExtensions?: readonly string[];
  supportsFreshReplay?: boolean;
}

/** Classifies durability conservatively at the weakest exposed boundary. */
export function classifyMcpToolDurability(metadata: McpToolDurabilityMetadata): ToolDurability {
  if (
    metadata.negotiatedExtensions?.includes(MCP_DURABLE_EFFECTS_EXTENSION) &&
    metadata.supportsFreshReplay === true
  ) {
    return "crank_native";
  }
  return "opaque";
}

/** Rejects requests that did not negotiate the required durable-effects extension. */
export function requireMcpDurableExtension(extensions: readonly string[] | undefined): void {
  if (!extensions?.includes(MCP_DURABLE_EFFECTS_EXTENSION)) {
    throw new CrankError("durable_extension_required", "Missing Required Client Capability");
  }
}

/** Serializable MRTR request algebra for authorize and commit. */
export type DurableEffectsMrtrInputRequest =
  | {
      type: typeof MCP_DURABLE_AUTHORIZE_REQUEST;
      key: string;
      invocationId: string;
      actionIndex: number;
      descriptor: Json;
    }
  | {
      type: typeof MCP_DURABLE_COMMIT_REQUEST;
      key: string;
      invocationId: string;
      pullId: string;
      attemptId: string;
      resolutionCapability: string;
      outcome: Json;
    };

/** Serializable MRTR response algebra preserving authority dispositions. */
export type DurableEffectsMrtrInputResponse =
  | {
      type: typeof MCP_DURABLE_AUTHORIZE_REQUEST;
      key: string;
      disposition: Json;
    }
  | {
      type: typeof MCP_DURABLE_COMMIT_REQUEST;
      key: string;
      result: Json;
    };

/** Projects an authorization disposition into a detached transport DTO. */
export function authorizationToMrtrResponse(
  key: string,
  disposition: Json,
): DurableEffectsMrtrInputResponse {
  return { type: MCP_DURABLE_AUTHORIZE_REQUEST, key, disposition: structuredClone(disposition) };
}

/** Projects a commit result into a detached transport DTO. */
export function commitToMrtrResponse(key: string, result: Json): DurableEffectsMrtrInputResponse {
  return { type: MCP_DURABLE_COMMIT_REQUEST, key, result: structuredClone(result) };
}

/** Minimizes a resolution receipt to stable, canonical transport fields. */
export function normalizeResolutionReceipt(receipt: ResolutionReceipt): Json {
  return canonicalSnapshot({
    sessionId: receipt.sessionId,
    taskId: receipt.taskId,
    pullId: receipt.pullId,
    resolutionOffset: receipt.resolutionOffset,
    outcomeDigest: receipt.outcomeDigest,
    status: receipt.status,
  }).value;
}

/** Deployment-owned authenticated encryption port bound to caller and invocation identity. */
export interface RequestStateCipher {
  seal(plaintext: Uint8Array, associatedData: string): Uint8Array;
  open(ciphertext: Uint8Array, associatedData: string): Uint8Array;
}

/** Encrypted in-memory checkpoint record; plaintext is never retained. */
export interface StoredMcpRequestState {
  invocationId: string;
  callerId: string;
  ciphertext: Uint8Array;
  updatedAt: number;
}

/**
 * Latest-checkpoint-only requestState storage. The caller supplies the
 * deployment encryption primitive; plaintext is never retained.
 */
export class InMemoryMcpRequestStateStore {
  readonly #entries = new Map<string, StoredMcpRequestState>();
  readonly #cipher: RequestStateCipher;
  readonly #maxBytes: number;
  readonly #now: () => number;

  constructor(options: { cipher: RequestStateCipher; maxBytes?: number; now?: () => number }) {
    this.#cipher = options.cipher;
    this.#maxBytes = options.maxBytes ?? MCP_REQUEST_STATE_MAX_BYTES;
    this.#now = options.now ?? Date.now;
  }

  /** Encrypts and replaces the latest checkpoint for an invocation. */
  put(invocationId: string, callerId: string, requestState: Uint8Array): void {
    requireIdentity(invocationId, "invocationId");
    requireIdentity(callerId, "callerId");
    if (requestState.byteLength > this.#maxBytes) {
      throw new CrankError("payload_too_large");
    }
    const associatedData = binding(invocationId, callerId);
    const ciphertext = this.#cipher.seal(new Uint8Array(requestState), associatedData);
    this.#entries.set(invocationId, {
      invocationId,
      callerId,
      ciphertext: new Uint8Array(ciphertext),
      updatedAt: this.#now(),
    });
  }

  /** Opens a caller-bound checkpoint, deleting expired or unauthentic records. */
  get(invocationId: string, callerId: string, maxAgeMs?: number): Uint8Array | undefined {
    const stored = this.#entries.get(invocationId);
    if (!stored || stored.callerId !== callerId) {
      return undefined;
    }
    if (maxAgeMs !== undefined && this.#now() - stored.updatedAt > maxAgeMs) {
      this.#entries.delete(invocationId);
      return undefined;
    }
    try {
      const plaintext = this.#cipher.open(
        new Uint8Array(stored.ciphertext),
        binding(invocationId, callerId),
      );
      if (plaintext.byteLength > this.#maxBytes) {
        this.#entries.delete(invocationId);
        return undefined;
      }
      return new Uint8Array(plaintext);
    } catch {
      this.#entries.delete(invocationId);
      return undefined;
    }
  }

  /** Deletes checkpoint state after terminal completion. */
  deleteTerminal(invocationId: string): void {
    this.#entries.delete(invocationId);
  }

  /** Returns a ciphertext-only defensive copy for diagnostics and tests. */
  inspectEncrypted(invocationId: string): StoredMcpRequestState | undefined {
    const stored = this.#entries.get(invocationId);
    return stored ? { ...stored, ciphertext: new Uint8Array(stored.ciphertext) } : undefined;
  }
}

/** Recovery result choosing a checkpoint or an explicitly fresh replay. */
export type RequestStateRecovery<T> =
  | { mode: "checkpoint"; state: Uint8Array }
  | { mode: "fresh_replay"; value: T };

/** Recovers an unexpired checkpoint or invokes the caller-owned replay fallback. */
export function recoverMcpRequestState<T>(options: {
  store: InMemoryMcpRequestStateStore;
  invocationId: string;
  callerId: string;
  maxAgeMs?: number;
  freshReplay: () => T;
}): RequestStateRecovery<T> {
  const state = options.store.get(options.invocationId, options.callerId, options.maxAgeMs);
  if (state) {
    return { mode: "checkpoint", state };
  }
  return { mode: "fresh_replay", value: options.freshReplay() };
}

function binding(invocationId: string, callerId: string): string {
  return stableTupleHash([MCP_DURABLE_EFFECTS_EXTENSION, invocationId, callerId]);
}

function requireIdentity(value: string, name: string): void {
  if (!value) {
    throw new CrankError("invalid_command", `${name} must be non-empty`);
  }
}
