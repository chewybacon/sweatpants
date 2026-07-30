import { CrankError } from "@sweatpants/durable-execution";
import {
  canonicalJson,
  compareUnicodeCodePoints,
  sha256,
  sortStrings,
} from "@sweatpants/foundation";
import { type Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const DURABLE_INVOCATION_META_KEY = "sweatpants.chat/invocation" as const;
export const DURABLE_INVOCATION_FORMAT = "sweatpants.chat/durable-invocations.v1" as const;
export const MCP_INVENTORY_FORMAT = "sweatpants.mcp-inventory.v1" as const;
export const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const durableInvocationMetaSchema = z.strictObject({
  format: z.literal(DURABLE_INVOCATION_FORMAT),
  idempotencyKey: z.string().refine((value) => {
    const bytes = new TextEncoder().encode(value).byteLength;
    return bytes >= 1 && bytes <= MAX_IDEMPOTENCY_KEY_BYTES;
  }),
  inventoryGeneration: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type Sha256 = string;
export type RequiredClientCapability = "elicitation" | "sampling";

export interface DurableInvocationMeta {
  readonly format: typeof DURABLE_INVOCATION_FORMAT;
  readonly idempotencyKey: string;
  readonly inventoryGeneration: Sha256;
}

export interface McpInventoryTool {
  readonly programId: string;
  readonly version: string;
  readonly programDigest: Sha256;
  readonly inputSchemaDigest: Sha256;
  readonly outputSchemaDigest: Sha256;
  readonly requiredClientCapabilities: readonly RequiredClientCapability[];
}

export interface McpInventoryGeneration {
  readonly format: typeof MCP_INVENTORY_FORMAT;
  readonly digest: Sha256;
  readonly collectionDigest: Sha256;
  readonly evaluatorAbi: string;
  readonly tools: Readonly<Record<string, McpInventoryTool>>;
}

export interface McpInventoryInput {
  readonly collectionDigest: Sha256;
  readonly evaluatorAbi: string;
  readonly tools: Readonly<Record<string, McpInventoryTool>>;
}

export interface McpSessionBinding {
  readonly format: "sweatpants.mcp-session.v1";
  readonly sessionId: string;
  readonly authenticatedCallerHash: Sha256;
  readonly inventoryGeneration: Sha256;
  readonly clientCapabilities: readonly RequiredClientCapability[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface DurableInvocationIdentity {
  readonly format: "sweatpants.durable-invocation-identity.v1";
  readonly serverId: string;
  readonly callerHash: Sha256;
  readonly toolName: string;
  readonly inventoryGeneration: Sha256;
  readonly idempotencyKeyHash: Sha256;
  readonly argumentDigest: Sha256;
  readonly exactProgram: { readonly id: string; readonly version: string; readonly digest: Sha256 };
}

export type IdempotencyCreateResult<T> =
  | { readonly status: "created"; readonly value: T }
  | { readonly status: "existing"; readonly value: T }
  | { readonly status: "conflict" };

export interface DurableIdempotencyStore<T> {
  createOrReturn(
    identity: DurableInvocationIdentity,
    value: T,
  ): Operation<IdempotencyCreateResult<T>>;
  get(identity: DurableInvocationIdentity): Operation<T | null>;
}

interface IdempotencyEntry<T> {
  readonly identity: DurableInvocationIdentity;
  readonly value: T;
}

/** Deterministic/local adapter. Production profiles must provide a transactional durable adapter. */
export class InMemoryDurableIdempotencyStore<T> implements DurableIdempotencyStore<T> {
  private readonly entries = new Map<string, IdempotencyEntry<T>>();

  *createOrReturn(
    identity: DurableInvocationIdentity,
    value: T,
  ): Operation<IdempotencyCreateResult<T>> {
    const key = invocationScopeKey(identity);
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, { identity: structuredClone(identity), value });
      return { status: "created", value };
    }
    if (canonicalJson(existing.identity) !== canonicalJson(identity)) {
      return { status: "conflict" };
    }
    return { status: "existing", value: existing.value };
  }

  *get(identity: DurableInvocationIdentity): Operation<T | null> {
    const existing = this.entries.get(invocationScopeKey(identity));
    if (!existing || canonicalJson(existing.identity) !== canonicalJson(identity)) {
      return null;
    }
    return existing.value;
  }
}

export function parseDurableInvocationMeta(value: unknown): DurableInvocationMeta {
  const parsed = durableInvocationMetaSchema.safeParse(value);
  if (!parsed.success) {
    throw new CrankError("invalid_mcp_request", "Invalid durable invocation metadata");
  }
  return parsed.data;
}

export function createMcpInventory(input: McpInventoryInput): McpInventoryGeneration {
  requireSha(input.collectionDigest, "collectionDigest");
  if (input.evaluatorAbi.length === 0) {
    throw new CrankError("tool_not_ready", "Evaluator ABI is required");
  }
  const sortedTools: Record<string, McpInventoryTool> = {};
  for (const name of sortStrings(Object.keys(input.tools))) {
    const tool = input.tools[name]!;
    const capabilities = [...tool.requiredClientCapabilities];
    assertSortedUnique(capabilities, `tools.${name}.requiredClientCapabilities`);
    requireSha(tool.programDigest, `${name}.programDigest`);
    requireSha(tool.inputSchemaDigest, `${name}.inputSchemaDigest`);
    requireSha(tool.outputSchemaDigest, `${name}.outputSchemaDigest`);
    sortedTools[name] = structuredClone(tool);
  }
  const document = {
    format: MCP_INVENTORY_FORMAT,
    collectionDigest: input.collectionDigest,
    evaluatorAbi: input.evaluatorAbi,
    tools: sortedTools,
  };
  return { ...document, digest: sha256(`sweatpants.mcp-inventory.v1\0${canonicalJson(document)}`) };
}

export function createDurableInvocationIdentity(input: {
  readonly serverId: string;
  readonly callerHash: Sha256;
  readonly toolName: string;
  readonly inventory: McpInventoryGeneration;
  readonly metadata: DurableInvocationMeta;
  readonly arguments: Json;
}): DurableInvocationIdentity {
  if (input.metadata.inventoryGeneration !== input.inventory.digest) {
    throw new CrankError("inventory_generation_mismatch");
  }
  const tool = input.inventory.tools[input.toolName];
  if (!tool) {
    throw new CrankError("tool_not_ready", `Tool is not ready: ${input.toolName}`);
  }
  return {
    format: "sweatpants.durable-invocation-identity.v1",
    serverId: input.serverId,
    callerHash: requireSha(input.callerHash, "callerHash"),
    toolName: input.toolName,
    inventoryGeneration: input.inventory.digest,
    idempotencyKeyHash: sha256(
      `sweatpants.mcp-idempotency-key.v1\0${input.metadata.idempotencyKey}`,
    ),
    argumentDigest: sha256(`sweatpants.mcp-arguments.v1\0${canonicalJson(input.arguments)}`),
    exactProgram: { id: tool.programId, version: tool.version, digest: tool.programDigest },
  };
}

export function assertClientCapabilities(
  tool: McpInventoryTool,
  negotiated: readonly RequiredClientCapability[],
): void {
  const available = new Set(negotiated);
  const missing = tool.requiredClientCapabilities.find((capability) => !available.has(capability));
  if (missing) {
    throw new CrankError("client_capability_required", `Client capability required: ${missing}`, {
      capability: missing,
    });
  }
}

function invocationScopeKey(identity: DurableInvocationIdentity): string {
  return canonicalJson({
    serverId: identity.serverId,
    callerHash: identity.callerHash,
    toolName: identity.toolName,
    inventoryGeneration: identity.inventoryGeneration,
    idempotencyKeyHash: identity.idempotencyKeyHash,
  });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new CrankError("invalid_mcp_request", `${field} must be a string`);
  }
  return value;
}

function requireSha(value: unknown, field: string): Sha256 {
  const digest = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new CrankError("invalid_mcp_request", `${field} must be lowercase SHA-256`);
  }
  return digest;
}

function assertSortedUnique(values: readonly string[], field: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareUnicodeCodePoints(values[index - 1]!, values[index]!) >= 0) {
      throw new CrankError("tool_not_ready", `${field} must be sorted and duplicate-free`);
    }
  }
}
