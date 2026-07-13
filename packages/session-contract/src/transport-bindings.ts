import { canonicalSnapshot } from "./canonical.ts";
import { CrankError, type Json } from "./types.ts";
import type {
  ReserveOperationResult,
  ResolutionReceipt,
  ResolveOperationResult,
} from "./durable-types.ts";

export const MCP_DURABLE_EFFECTS_EXTENSION = "works.earendil/durable-effects-v1";
export const MCP_DURABLE_AUTHORIZE_REQUEST = "works.earendil/durable-effects/authorize";
export const MCP_DURABLE_COMMIT_REQUEST = "works.earendil/durable-effects/commit";
export const MCP_REQUEST_STATE_MAX_BYTES = 1024 * 1024;

export type ToolDurability = "opaque" | "server_task" | "crank_native";

export interface McpToolDurabilityMetadata {
  negotiatedExtensions?: readonly string[];
  supportsFreshReplay?: boolean;
  serverTask?: boolean;
}

export function classifyMcpToolDurability(metadata: McpToolDurabilityMetadata): ToolDurability {
  if (
    metadata.negotiatedExtensions?.includes(MCP_DURABLE_EFFECTS_EXTENSION) &&
    metadata.supportsFreshReplay === true
  ) {
    return "crank_native";
  }
  if (metadata.serverTask) {
    return "server_task";
  }
  return "opaque";
}

export function requireMcpDurableExtension(extensions: readonly string[] | undefined): void {
  if (!extensions?.includes(MCP_DURABLE_EFFECTS_EXTENSION)) {
    throw new CrankError("durable_extension_required", "Missing Required Client Capability");
  }
}

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

export type DurableEffectsMrtrInputResponse =
  | {
      type: typeof MCP_DURABLE_AUTHORIZE_REQUEST;
      key: string;
      disposition: ReserveOperationResult;
    }
  | {
      type: typeof MCP_DURABLE_COMMIT_REQUEST;
      key: string;
      result: ResolveOperationResult;
    };

export function authorizationToMrtrResponse(
  key: string,
  disposition: ReserveOperationResult,
): DurableEffectsMrtrInputResponse {
  return { type: MCP_DURABLE_AUTHORIZE_REQUEST, key, disposition: structuredClone(disposition) };
}

export function commitToMrtrResponse(
  key: string,
  result: ResolveOperationResult,
): DurableEffectsMrtrInputResponse {
  return { type: MCP_DURABLE_COMMIT_REQUEST, key, result: structuredClone(result) };
}

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

export interface RequestStateCipher {
  seal(plaintext: Uint8Array, associatedData: string): Uint8Array;
  open(ciphertext: Uint8Array, associatedData: string): Uint8Array;
}

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
        throw new Error("oversized plaintext");
      }
      return new Uint8Array(plaintext);
    } catch {
      this.#entries.delete(invocationId);
      return undefined;
    }
  }

  deleteTerminal(invocationId: string): void {
    this.#entries.delete(invocationId);
  }

  inspectEncrypted(invocationId: string): StoredMcpRequestState | undefined {
    const stored = this.#entries.get(invocationId);
    return stored ? { ...stored, ciphertext: new Uint8Array(stored.ciphertext) } : undefined;
  }
}

export type RequestStateRecovery<T> =
  | { mode: "checkpoint"; state: Uint8Array }
  | { mode: "fresh_replay"; value: T };

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
  return `${MCP_DURABLE_EFFECTS_EXTENSION}\u0000${invocationId}\u0000${callerId}`;
}

function requireIdentity(value: string, name: string): void {
  if (!value) {
    throw new CrankError("invalid_command", `${name} must be non-empty`);
  }
}
