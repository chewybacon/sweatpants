import { fromByteArray, toByteArray } from "base64-js";
import { call, type Operation } from "effection";
import { canonicalJson, stableTupleHash, type Json } from "@sweatpants/foundation";
import { z } from "zod";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_TOKEN_BYTES = 16_384;
const referenceSchema = z.strictObject({
  invocationId: z.string().min(1).max(1024),
  pullId: z.string().min(1).max(1024),
});
const payloadSchema = z.strictObject({
  version: z.literal(1),
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  reference: referenceSchema,
});

/** Semantic request identity. Excludes JSON-RPC id, requestState, and inputResponses. */
export interface McpContinuationBinding {
  readonly serverId: string;
  readonly callerId: string;
  readonly method: string;
  readonly params: Json;
}
export interface McpContinuationReference {
  readonly invocationId: string;
  readonly pullId: string;
}
export class McpContinuationError extends Error {
  constructor(
    readonly code:
      | "mcp_continuation_invalid"
      | "mcp_continuation_expired"
      | "mcp_continuation_binding_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "McpContinuationError";
  }
}
function invalid(message: string): never {
  throw new McpContinuationError("mcp_continuation_invalid", message);
}
function base64(bytes: Uint8Array): string {
  return fromByteArray(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unbase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    invalid("Invalid continuation encoding");
  }
  let decoded: Uint8Array;
  try {
    decoded = toByteArray(
      value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
  } catch {
    return invalid("Invalid continuation encoding");
  }
  if (base64(decoded) !== value) {
    invalid("Noncanonical continuation encoding");
  }
  return decoded;
}
function bindingDigest(binding: McpContinuationBinding): string {
  if (!binding.serverId || !binding.callerId || !binding.method) {
    invalid("Continuation binding identity is required");
  }
  return stableTupleHash([
    "sweatpants.mcp.continuation.v1",
    binding.serverId,
    binding.callerId,
    binding.method,
    binding.params,
  ]);
}

export interface McpContinuations {
  issue(binding: McpContinuationBinding, reference: McpContinuationReference): Operation<string>;
  verify(token: string, binding: McpContinuationBinding): Operation<McpContinuationReference>;
}

/**
 * Integrity-protected, bounded requestState. It holds only a journal reference,
 * never execution state or an authorization capability. The journal owns replay
 * and response deduplication; verifying a token does not consume the interaction.
 */
export function createMcpContinuations(options: {
  secret: string;
  verificationSecrets?: readonly string[];
  ttlMs?: number;
  now?: () => number;
}): McpContinuations {
  const ttlMs = options.ttlMs ?? 300_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    invalid("Continuation TTL must be a positive safe integer");
  }
  const secrets = [options.secret, ...(options.verificationSecrets ?? [])].map((secret) => {
    const bytes = encoder.encode(secret);
    if (bytes.length < 32 || bytes.length > 4096) {
      invalid("Continuation secrets require 32 to 4096 UTF-8 bytes");
    }
    return bytes;
  });
  if (secrets.length > 8) {
    invalid("At most eight continuation verification keys are supported");
  }
  const now = options.now ?? Date.now;
  function* key(bytes: Uint8Array): Operation<CryptoKey> {
    return yield* call(() =>
      crypto.subtle.importKey(
        "raw",
        Uint8Array.from(bytes).buffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    );
  }
  return {
    *issue(binding, reference) {
      const issuedAt = now();
      const parsed = payloadSchema.safeParse({
        version: 1,
        binding: bindingDigest(binding),
        issuedAt,
        expiresAt: issuedAt + ttlMs,
        reference,
      });
      if (!parsed.success) {
        invalid("Invalid continuation reference or clock");
      }
      const payload = encoder.encode(canonicalJson(parsed.data));
      const activeKey = yield* key(secrets[0]);
      const signature = yield* call(() => crypto.subtle.sign("HMAC", activeKey, payload));
      const token = `${base64(payload)}.${base64(new Uint8Array(signature))}`;
      if (token.length > MAX_TOKEN_BYTES) {
        invalid("Continuation exceeds its transfer bound");
      }
      return token;
    },
    *verify(token, binding) {
      if (typeof token !== "string" || encoder.encode(token).length > MAX_TOKEN_BYTES) {
        invalid("Continuation exceeds its transfer bound");
      }
      const parts = token.split(".");
      if (parts.length !== 2) {
        invalid("Continuation must contain payload and signature");
      }
      const payload = unbase64(parts[0]);
      const signature = unbase64(parts[1]);
      if (signature.length !== 32) {
        invalid("Invalid continuation signature");
      }
      let verified = false;
      for (const secret of secrets) {
        const verificationKey = yield* key(secret);
        if (
          yield* call(() =>
            crypto.subtle.verify(
              "HMAC",
              verificationKey,
              Uint8Array.from(signature).buffer,
              Uint8Array.from(payload).buffer,
            ),
          )
        ) {
          verified = true;
          break;
        }
      }
      if (!verified) {
        invalid("Invalid continuation signature");
      }
      let value: unknown;
      try {
        value = JSON.parse(decoder.decode(payload));
      } catch {
        return invalid("Invalid continuation payload");
      }
      const parsed = payloadSchema.safeParse(value);
      if (!parsed.success) {
        invalid("Invalid continuation payload");
      }
      const state = parsed.data;
      if (state.binding !== bindingDigest(binding)) {
        throw new McpContinuationError(
          "mcp_continuation_binding_mismatch",
          "Continuation request binding mismatch",
        );
      }
      const current = now();
      if (
        !Number.isSafeInteger(current) ||
        current < state.issuedAt ||
        state.expiresAt <= state.issuedAt
      ) {
        invalid("Invalid continuation clock");
      }
      if (current >= state.expiresAt) {
        throw new McpContinuationError("mcp_continuation_expired", "Expired continuation");
      }
      return state.reference;
    },
  };
}

const formResponseSchema = z
  .object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .optional(),
  })
  .refine((response) =>
    response.action === "accept" ? response.content !== undefined : response.content === undefined,
  );
export type McpFormResponse = z.infer<typeof formResponseSchema>;

/** Match exactly one requested form response; domain schema validation follows in the journal. */
export function decodeMcpFormResponse(inputResponses: unknown, requestId: string): McpFormResponse {
  const parsed = z.record(z.string(), formResponseSchema).safeParse(inputResponses);
  if (
    !parsed.success ||
    Object.keys(parsed.data).length !== 1 ||
    !Object.hasOwn(parsed.data, requestId)
  ) {
    return invalid("Expected exactly the pending form input response");
  }
  return parsed.data[requestId];
}
