import { sign as nodeSign, type KeyObject } from "node:crypto";
import { canonicalJson, type Json } from "@sweatpants/foundation";
import { z } from "zod";

export interface AgentCardSignatureV1 {
  readonly protected: string;
  readonly signature: string;
  readonly header?: Json;
}
export interface AgentCardSigner {
  sign(cardWithoutSignatures: Json): AgentCardSignatureV1;
}

export function createAgentCardJwsSigner(options: {
  readonly algorithm: "EdDSA" | "ES256" | "RS256";
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly jwksUrl?: string;
  readonly header?: Json;
}): AgentCardSigner {
  if (!options.keyId || options.keyId.length > 512) {
    throw new Error("Agent Card key ID is invalid");
  }
  if (options.jwksUrl && new URL(options.jwksUrl).protocol !== "https:") {
    throw new Error("Agent Card JWKS URL must use HTTPS");
  }
  return Object.freeze({
    sign(cardWithoutSignatures: Json) {
      const protectedHeader = {
        alg: options.algorithm,
        typ: "JOSE",
        kid: options.keyId,
        ...(options.jwksUrl ? { jku: options.jwksUrl } : {}),
      };
      const protectedValue = base64url(canonicalJson(protectedHeader));
      const payload = base64url(canonicalJson(agentCardSigningProjection(cardWithoutSignatures)));
      const signingInput = Buffer.from(`${protectedValue}.${payload}`, "ascii");
      const signature =
        options.algorithm === "EdDSA"
          ? nodeSign(null, signingInput, options.privateKey)
          : nodeSign("sha256", signingInput, {
              key: options.privateKey,
              ...(options.algorithm === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}),
            });
      return Object.freeze({
        protected: protectedValue,
        signature: signature.toString("base64url"),
        ...(options.header !== undefined ? { header: options.header } : {}),
      });
    },
  });
}

/** RFC 8785 input with signatures and known absent/default protobuf fields removed. */
export function agentCardSigningProjection(card: Json): Json {
  const parsed = z.record(z.string(), z.json()).safeParse(card);
  if (!parsed.success) {
    throw new Error("Agent Card signing input must be an object");
  }
  const clone = structuredClone(parsed.data);
  delete clone["signatures"];
  const capabilities = z
    .object({ extensions: z.array(z.json()).optional() })
    .loose()
    .safeParse(clone["capabilities"]);
  if (capabilities.success && capabilities.data.extensions?.length === 0) {
    const capabilityRecord = clone["capabilities"] as Record<string, Json>;
    delete capabilityRecord["extensions"];
  }
  return clone;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
