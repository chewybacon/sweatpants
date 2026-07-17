import { describe, expect, it } from "vitest";
import {
  DURABLE_INVOCATION_EXTENSION_URI,
  discoverForeignA2AAgent,
  prepareForeignA2AInvocation,
} from "../index.ts";

function card(withExtension = true) {
  return {
    name: "Opaque Foreign Agent",
    version: "1.2.0",
    supportedInterfaces: [
      {
        url: "https://foreign.example/a2a",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      extensions: withExtension
        ? [
            {
              uri: DURABLE_INVOCATION_EXTENSION_URI,
              params: {
                protocolVersion: 1,
                resolveEndpoint: "https://foreign.example/invocations:resolve",
                abortEndpoint: "https://foreign.example/invocations:abort",
                messageIdempotency: true,
                retention: {
                  invocationBindingSeconds: 600,
                  abortTombstoneSeconds: 600,
                  messageIdempotencySeconds: 300,
                  taskSeconds: 3600,
                  terminalResultSeconds: 3600,
                  clockSkewSeconds: 5,
                },
              },
            },
          ]
        : [],
    },
    securityRequirements: [{ schemes: { bearer: [] } }],
    skills: [{ id: "research", name: "Research" }],
  };
}
const policy = { resolve: async () => ["93.184.216.34"] };

describe("foreign A2A discovery and guarantee negotiation", () => {
  it("requires and pins reconciled mode by default", async () => {
    const discovered = await discoverForeignA2AAgent({
      source: { card: card(), cardOrigin: "https://foreign.example" },
      skillId: "research",
      principalId: "principal-1",
      supportedAuthSchemes: ["bearer"],
      urlPolicy: policy,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(discovered.guarantee).toMatchObject({
      level: "reconciled",
      source: "durable_invocation_extension",
      invocationExpiresAt: "2030-01-01T00:10:00.000Z",
      messageIdempotencyExpiresAt: "2030-01-01T00:05:00.000Z",
    });
    const pin = prepareForeignA2AInvocation({
      discovery: discovered,
      derivationKey: "deployment-derivation-key-with-at-least-32-bytes",
      localIdentity: { taskId: "private/root", pullId: "private-pull" },
      principalId: "principal-1",
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(pin.invocationId).not.toContain("private");
    expect(pin.cardDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails before dispatch when the default guarantee is unavailable", async () => {
    await expect(
      discoverForeignA2AAgent({
        source: { card: card(false), cardOrigin: "https://foreign.example" },
        skillId: "research",
        principalId: "principal-1",
        supportedAuthSchemes: ["bearer"],
        urlPolicy: policy,
      }),
    ).rejects.toMatchObject({ code: "a2a_guarantee_unavailable" });
  });

  it("requires duplicate-risk acknowledgment before pinning degraded automatic retry", async () => {
    const discovered = await discoverForeignA2AAgent({
      source: { card: card(false), cardOrigin: "https://foreign.example" },
      skillId: "research",
      principalId: "principal-1",
      supportedAuthSchemes: ["bearer"],
      minimumGuarantee: "task_handle_only",
      urlPolicy: policy,
    });
    expect(() =>
      prepareForeignA2AInvocation({
        discovery: discovered,
        derivationKey: "deployment-derivation-key-with-at-least-32-bytes",
        localIdentity: { pullId: "pull-duplicate-risk" },
        principalId: "principal-1",
        ambiguityPolicy: "retry_may_duplicate",
      }),
    ).toThrowError(expect.objectContaining({ code: "a2a_duplicate_risk_not_acknowledged" }));
    expect(
      prepareForeignA2AInvocation({
        discovery: discovered,
        derivationKey: "deployment-derivation-key-with-at-least-32-bytes",
        localIdentity: { pullId: "pull-duplicate-risk" },
        principalId: "principal-1",
        ambiguityPolicy: "retry_may_duplicate",
        acknowledgeDuplicateRisk: true,
      }),
    ).toMatchObject({ ambiguityPolicy: "retry_may_duplicate", duplicateRiskAcknowledged: true });
  });

  it("allows explicit, recorded idempotent-message attestation", async () => {
    const discovered = await discoverForeignA2AAgent({
      source: { card: card(false), cardOrigin: "https://foreign.example" },
      skillId: "research",
      principalId: "principal-1",
      supportedAuthSchemes: ["bearer"],
      minimumGuarantee: "idempotent_messages",
      idempotentMessagesAttestation: {
        source: "operator_attestation",
        retentionSeconds: 120,
      },
      urlPolicy: policy,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(discovered.guarantee).toEqual({
      level: "idempotent_messages",
      source: "operator_attestation",
      negotiatedAt: "2030-01-01T00:00:00.000Z",
      messageIdempotencyExpiresAt: "2030-01-01T00:02:00.000Z",
    });
  });
});
