import { CrankError } from "@sweatpants/session-contract";
import type {
  AbortForeignInvocationResult,
  ResolveForeignInvocationResult,
} from "./foreign-client.ts";
import type { ForeignA2ARetentionV1, ForeignA2ASendResult } from "./foreign-task-types.ts";

export interface DurableInvocationCreateRequest {
  readonly principalId: string;
  readonly tenantId?: string;
  readonly invocationId: string;
  readonly messageId: string;
  readonly messageDigest: string;
  readonly requestExpiresAt: string;
}
export interface DurableInvocationLookupRequest {
  readonly principalId: string;
  readonly tenantId?: string;
  readonly invocationId: string;
  readonly messageDigest: string;
  readonly requestExpiresAt: string;
}
export interface DurableInvocationMessageRequest extends DurableInvocationLookupRequest {
  readonly messageId: string;
  readonly taskId: string;
  readonly contextId?: string;
}

type RecordState =
  | {
      type: "pending";
      digest: string;
      requestExpiresAt: number;
      result: Promise<ForeignA2ASendResult>;
      retentionExpiresAt: number;
    }
  | {
      type: "bound";
      digest: string;
      requestExpiresAt: number;
      result: ForeignA2ASendResult;
      retentionExpiresAt: number;
    }
  | { type: "aborted"; digest: string; expiresAt: number };
type MessageRecord = {
  digest: string;
  result: Promise<ForeignA2ASendResult>;
  expiresAt: number;
};

/** In-memory reference semantics for the durable-invocation extension. */
export class InMemoryDurableInvocationService {
  readonly #records = new Map<string, RecordState>();
  readonly #messages = new Map<string, MessageRecord>();
  readonly #retention: ForeignA2ARetentionV1;
  readonly #now: () => number;

  constructor(options: { retention: ForeignA2ARetentionV1; now?: () => number }) {
    validateRetention(options.retention);
    this.#retention = Object.freeze({ ...options.retention });
    this.#now = options.now ?? Date.now;
  }

  async create(
    request: DurableInvocationCreateRequest,
    execute: () => Promise<ForeignA2ASendResult>,
  ): Promise<ForeignA2ASendResult> {
    this.#prune();
    const now = this.#now();
    const requestExpiry = parseExpiry(request.requestExpiresAt);
    if (now >= requestExpiry) {
      throw new CrankError("a2a_request_expired", "Invocation create request expired");
    }
    const key = invocationKey(request);
    const previous = this.#records.get(key);
    if (previous) {
      assertDigest(previous.digest, request.messageDigest);
      if (previous.type === "aborted") {
        throw new CrankError("a2a_invocation_aborted", "Invocation was aborted");
      }
      if (previous.type === "bound") {
        return previous.result;
      }
      return previous.result;
    }
    const promise = Promise.resolve().then(execute);
    const record: RecordState = {
      type: "pending",
      digest: request.messageDigest,
      requestExpiresAt: requestExpiry,
      result: promise,
      retentionExpiresAt: now + this.#retention.invocationBindingSeconds * 1_000,
    };
    this.#records.set(key, record);
    try {
      const result = await promise;
      const current = this.#records.get(key);
      if (current !== record) {
        throw new CrankError("a2a_protocol_error", "Invocation binding changed while pending");
      }
      this.#records.set(key, { ...record, type: "bound", result });
      return result;
    } catch (error) {
      if (this.#records.get(key) === record) {
        this.#records.delete(key);
      }
      throw error;
    }
  }

  async resolve(request: DurableInvocationLookupRequest): Promise<ResolveForeignInvocationResult> {
    this.#prune();
    const record = this.#records.get(invocationKey(request));
    if (!record) {
      return { status: "not_found" };
    }
    assertDigest(record.digest, request.messageDigest);
    if (record.type === "aborted") {
      return { status: "aborted", expiresAt: new Date(record.expiresAt).toISOString() };
    }
    const result = record.type === "pending" ? await record.result : record.result;
    return { status: "bound", result };
  }

  async abort(request: DurableInvocationLookupRequest): Promise<AbortForeignInvocationResult> {
    this.#prune();
    const key = invocationKey(request);
    const record = this.#records.get(key);
    if (record) {
      assertDigest(record.digest, request.messageDigest);
      if (record.type === "aborted") {
        return { status: "aborted", expiresAt: new Date(record.expiresAt).toISOString() };
      }
      const result = record.type === "pending" ? await record.result : record.result;
      return { status: "bound", result };
    }
    const requestExpiry = parseExpiry(request.requestExpiresAt);
    const minimum = requestExpiry + this.#retention.clockSkewSeconds * 1_000;
    const configured = this.#now() + this.#retention.abortTombstoneSeconds * 1_000;
    const expiresAt = Math.max(minimum, configured);
    this.#records.set(key, { type: "aborted", digest: request.messageDigest, expiresAt });
    return { status: "aborted", expiresAt: new Date(expiresAt).toISOString() };
  }

  async processMessage(
    request: DurableInvocationMessageRequest,
    execute: () => Promise<ForeignA2ASendResult>,
  ): Promise<ForeignA2ASendResult> {
    this.#prune();
    const invocation = this.#records.get(invocationKey(request));
    if (!invocation || invocation.type !== "bound") {
      throw new CrankError("a2a_invocation_not_bound", "Continuation requires a bound invocation");
    }
    if (
      invocation.result.type !== "task" ||
      invocation.result.task.id !== request.taskId ||
      invocation.result.task.contextId !== request.contextId
    ) {
      throw new CrankError(
        "a2a_binding_conflict",
        "Continuation task/context differs from the invocation binding",
      );
    }
    const key = `${invocationKey(request)}\u0000${request.messageId}`;
    const previous = this.#messages.get(key);
    if (previous) {
      assertDigest(previous.digest, request.messageDigest);
      return previous.result;
    }
    const result = Promise.resolve().then(execute);
    this.#messages.set(key, {
      digest: request.messageDigest,
      result,
      expiresAt: this.#now() + this.#retention.messageIdempotencySeconds * 1_000,
    });
    try {
      return await result;
    } catch (error) {
      this.#messages.delete(key);
      throw error;
    }
  }

  recordCount(): { invocations: number; messages: number } {
    this.#prune();
    return { invocations: this.#records.size, messages: this.#messages.size };
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, record] of this.#records) {
      const expires = record.type === "aborted" ? record.expiresAt : record.retentionExpiresAt;
      if (record.type !== "pending" && now >= expires) {
        this.#records.delete(key);
      }
    }
    for (const [key, record] of this.#messages) {
      if (now >= record.expiresAt) {
        this.#messages.delete(key);
      }
    }
  }
}

function invocationKey(request: {
  principalId: string;
  tenantId?: string;
  invocationId: string;
}): string {
  if (!request.principalId || !request.invocationId) {
    throw new CrankError("a2a_protocol_error", "Invocation identity is incomplete");
  }
  return `${request.principalId}\u0000${request.tenantId ?? ""}\u0000${request.invocationId}`;
}
function assertDigest(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new CrankError("idempotency_conflict", "Invocation identity content conflict");
  }
}
function parseExpiry(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) {
    throw new CrankError("a2a_protocol_error", "Invalid request expiration");
  }
  return result;
}
function validateRetention(value: ForeignA2ARetentionV1): void {
  for (const [name, duration] of Object.entries(value)) {
    if (
      !Number.isSafeInteger(duration) ||
      duration < 0 ||
      (name !== "clockSkewSeconds" && duration === 0)
    ) {
      throw new CrankError("invalid_descriptor", `Invalid durable-invocation retention ${name}`);
    }
  }
}
