import { generateKeyPairSync } from "node:crypto";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import { canonicalJson, canonicalSnapshot } from "@sweatpants/foundation";
import {
  DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES,
  DURABLE_DRIVER_FIXTURE_TOOLS,
} from "@sweatpants/journal-authority/testing";
import {
  DELEGATED_EFFECTS_EXTENSION_URI,
  DURABLE_INVOCATION_EXTENSION_URI,
  InMemoryDelegatedEffectsService,
  PeerDelegatedEffectCoordinator,
  SWEATPANTS_PEER_PROFILE_URI,
  buildPeerOffer,
  callPeerAgent,
  compilePeerResolverBundle,
  createPeerStartRequest,
  createPeerRequirementManifest,
  createPeerTerminalEvidence,
  definePeerEffectContract,
  delegatedEffectsClientFromPromises,
  discoverSweatpantsPeer,
  finalizeGrantSet,
  negotiatePeerGrantSet,
  peerResolverTaskId,
  verifyPeerTaskEcho,
  verifyPeerTerminalEvidence,
  type ForeignA2AInvocationPin,
  type PeerEffectOffer,
  type PeerInvocationPin,
  type PeerRetentionV1,
} from "../index.ts";

const effect = DURABLE_DRIVER_FIXTURE_TOOLS[0]!.manifest.effects["echo"]!;
const contract = definePeerEffectContract(effect);
const inputSchema = DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES.find(
  (entry) => entry.descriptor.digest === effect.inputSchema.digest,
)!.schema;
const outputSchema = DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES.find(
  (entry) => entry.descriptor.digest === effect.outputSchema.digest,
)!.schema;
const registration = createDurableEffectRegistration(
  effect,
  { mode: "idempotent", mechanism: "pull_id_key" },
  function* (input) {
    return { status: "ok", value: input };
  },
  { input: inputSchema, output: outputSchema },
);
const registry = createDurableEffectRegistry([registration]);
const requirement = createPeerRequirementManifest({
  skillId: "peer-review",
  amendmentRequests: true,
  releaseDigest: "b".repeat(64),
  requirements: [
    {
      contract,
      availability: "route_negotiable",
      required: true,
      allowedRoutes: ["caller", "callee"],
    },
  ],
});
const offerEntry: PeerEffectOffer = {
  contractDigest: contract.contractDigest,
  route: "caller",
  constraints: { maxCalls: 2 },
  budget: { units: 10 },
  delegation: { mode: "none" },
};
const offer = buildPeerOffer({
  manifest: requirement,
  routes: { echo: offerEntry },
  effectRegistry: registry,
  amendmentRequests: true,
});
const grants = negotiatePeerGrantSet({
  manifest: requirement,
  offer,
  callerIdentity: "caller-peer",
  calleeIdentity: "callee-peer",
  invocationId: "peer-invocation",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const retention: PeerRetentionV1 = {
  taskSeconds: 3600,
  invocationBindingSeconds: 3600,
  effectEventSeconds: 3600,
  grantSeconds: 3600,
  effectResponseSeconds: 3600,
  cancellationEvidenceSeconds: 3600,
  terminalEvidenceSeconds: 3600,
};

describe("Sweatpants peer contract and grant negotiation", () => {
  it("pins whole contracts, canonical offers, and deterministic grant sets", () => {
    expect(contract.contractDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(requirement.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(grants.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      negotiatePeerGrantSet({
        manifest: requirement,
        offer,
        callerIdentity: "caller-peer",
        calleeIdentity: "callee-peer",
        invocationId: "peer-invocation",
        expiresAt: grants.grants[0]!.expiresAt,
      }).digest,
    ).toBe(grants.digest);
  });

  it("fails preflight for missing caller handlers and rejects duplicate symbolic names", () => {
    expect(() =>
      buildPeerOffer({
        manifest: requirement,
        routes: { echo: offerEntry },
        effectRegistry: createDurableEffectRegistry([]),
      }),
    ).toThrowError(expect.objectContaining({ code: "peer_required_effect_unavailable" }));
    expect(() =>
      createPeerRequirementManifest({
        skillId: "bad",
        amendmentRequests: false,
        releaseDigest: "b".repeat(64),
        requirements: [
          requirement.requirements[0]!,
          { ...requirement.requirements[0]!, contract: { ...contract, version: "2" } },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "peer_effect_contract_mismatch" }));
  });

  it("compiles one exact granted effect into a deterministic resolver bundle", () => {
    const bundle = compilePeerResolverBundle(grants.grants[0]!);
    expect(Object.keys(bundle.tool.manifest.effects)).toEqual(["echo"]);
    expect(bundle.tool.manifest.digest).toBe(
      compilePeerResolverBundle(grants.grants[0]!).tool.manifest.digest,
    );
    expect(peerResolverTaskId("peer-task", "effect-1")).toBe(
      peerResolverTaskId("peer-task", "effect-1"),
    );
  });
});

describe("delegated effect two-frontier protocol", () => {
  it("records gap-free events, observes cancellation ahead, and delivers one idempotent response", async () => {
    const service = new InMemoryDelegatedEffectsService({ retention });
    service.createTask({
      taskId: "peer-task",
      invocationId: "peer-invocation",
      callerIdentity: "caller-peer",
      calleeIdentity: "callee-peer",
      grantSet: grants,
    });
    const grant = grants.grants[0]!;
    const first = service.appendEffectRequest({
      taskId: "peer-task",
      effectId: "effect-1",
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      contractDigest: grant.contract.contractDigest,
      value: "first",
    });
    service.appendEffectRequest({
      taskId: "peer-task",
      effectId: "effect-2",
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      contractDigest: grant.contract.contractDigest,
      value: "second",
    });
    service.appendEffectCancellation({
      taskId: "peer-task",
      effectId: "effect-1",
      cancelId: "cancel-effect-1",
      reason: "callee unwind",
    });
    const pin = peerPin();
    const client = delegatedEffectsClientFromPromises({
      listEvents: async (taskId, cursor, size) => service.listEvents(taskId, cursor, size),
      getEffectStatus: async (taskId, effectId) => service.getEffectStatus(taskId, effectId),
      resolveEffect: async (response) => service.resolveEffect(response),
      applyAmendment: async (taskId, amendment) => service.applyAmendment(taskId, amendment),
      revokeGrant: async (taskId, revocation) => service.revokeGrant(taskId, revocation),
    });
    const coordinator = new PeerDelegatedEffectCoordinator({ pin, taskId: "peer-task", client });
    let state = await run(() => coordinator.observe(coordinator.initialState()));
    expect(state.observationCursor).toBe(3);
    expect(state.executionCursor).toBe(0);
    expect(state.cancellationRequestedEffects).toContain("effect-1");
    let executions = 0;
    state = await run(() =>
      coordinator.prepareNextResponse(state, function* () {
        executions += 1;
        return { status: "ok", value: "must-not-run" };
      }),
    );
    expect(executions).toBe(0);
    expect(state.responseOutbox[0]).toMatchObject({
      effectId: first.effectId,
      outcome: { status: "cancelled" },
    });
    state = await run(() => coordinator.deliverOutbox(state));
    expect(state.executionCursor).toBe(1);
    const duplicateAck = service.resolveEffect(state.responseOutbox[0]!);
    expect(duplicateAck.status).toBe("duplicate");
    expect(coordinator.diagnostics(state)).toMatchObject({
      observationCursor: 3,
      executionCursor: 1,
      queueDepth: 1,
    });
  });

  it("detects event gaps, conflicting response identities, amendments, and revocation", () => {
    const service = new InMemoryDelegatedEffectsService({ retention });
    service.createTask({
      taskId: "peer-task",
      invocationId: "peer-invocation",
      callerIdentity: "caller-peer",
      calleeIdentity: "callee-peer",
      grantSet: grants,
    });
    const grant = grants.grants[0]!;
    service.appendEffectRequest({
      taskId: "peer-task",
      effectId: "effect-1",
      grantId: grant.grantId,
      grantVersion: 1,
      contractDigest: contract.contractDigest,
      value: "value",
    });
    const page = service.listEvents("peer-task", 0);
    const coordinator = new PeerDelegatedEffectCoordinator({
      pin: peerPin(),
      taskId: "peer-task",
      client: {} as never,
    });
    expect(() =>
      coordinator.recordPage(coordinator.initialState(), {
        ...page,
        events: [{ ...page.events[0]!, cursor: 2 }],
      }),
    ).toThrowError(expect.objectContaining({ code: "peer_event_page_invalid" }));

    const amended = finalizeGrantSet({
      version: 2,
      previousDigest: grants.digest,
      requirementManifestDigest: grants.requirementManifestDigest,
      grants: grants.grants.map((value) => ({ ...value, grantVersion: 2 })),
      amendmentRequests: true,
    });
    const amendment = {
      amendmentId: "amendment-1",
      previousGrantDigest: grants.digest,
      grantSet: amended,
    };
    expect(service.applyAmendment("peer-task", amendment)).toMatchObject({ status: "accepted" });
    expect(service.applyAmendment("peer-task", amendment)).toMatchObject({ status: "duplicate" });
    const revocationBody = {
      revocationId: "revoke-1",
      grantId: amended.grants[0]!.grantId,
      grantVersion: 2,
      reason: "policy changed",
    };
    const revocation = {
      ...revocationBody,
      revocationDigest: canonicalSnapshot(revocationBody).sha,
    };
    expect(service.revokeGrant("peer-task", revocation)).toMatchObject({ status: "accepted" });
    expect(service.revokeGrant("peer-task", revocation)).toMatchObject({ status: "duplicate" });
  });
});

describe("Sweatpants peer discovery and facade", () => {
  it("fails closed on the full peer profile, pins grants, and echoes them on the task", async () => {
    const peerRetention = retention;
    const card = {
      name: "Callee Sweatpants Peer",
      version: "1.0.0",
      supportedInterfaces: [
        {
          url: "https://callee.example/a2a",
          protocolBinding: "HTTP+JSON",
          protocolVersion: "1.0",
        },
      ],
      capabilities: {
        extensions: [
          {
            uri: DURABLE_INVOCATION_EXTENSION_URI,
            params: {
              protocolVersion: 1,
              resolveEndpoint: "https://callee.example/invocations:resolve",
              abortEndpoint: "https://callee.example/invocations:abort",
              messageIdempotency: true,
              retention: {
                invocationBindingSeconds: 3600,
                abortTombstoneSeconds: 3600,
                messageIdempotencySeconds: 3600,
                taskSeconds: 3600,
                terminalResultSeconds: 3600,
                clockSkewSeconds: 5,
              },
            },
          },
          {
            uri: SWEATPANTS_PEER_PROFILE_URI,
            params: {
              protocolVersion: 1,
              delegatedEffectsVersion: 1,
              requirementManifestEndpoint: "https://callee.example/peer/requirements",
              delegatedEffectsEndpoint: "https://callee.example/peer/effects",
              retention: peerRetention,
            },
          },
          { uri: DELEGATED_EFFECTS_EXTENSION_URI, params: { protocolVersion: 1 } },
        ],
      },
      skills: [{ id: "peer-review", name: "Peer review" }],
    };
    const encoded = new TextEncoder().encode(canonicalJson(requirement));
    const httpClient = {
      async get() {
        return {
          url: new URL("https://callee.example/peer/requirements?skillId=peer-review"),
          status: 200,
          headers: {
            "a2a-extensions": `${SWEATPANTS_PEER_PROFILE_URI},${DELEGATED_EFFECTS_EXTENSION_URI}`,
          },
          body: encoded,
        };
      },
      async request() {
        throw new Error("unused");
      },
    };
    const discovered = await discoverSweatpantsPeer({
      source: { card, cardOrigin: "https://callee.example" },
      skillId: "peer-review",
      principalId: "caller-peer",
      calleeIdentity: "callee-peer",
      supportedAuthSchemes: [],
      derivationKey: "peer-discovery-derivation-key-at-least-32-bytes",
      localIdentity: { taskId: "caller/root", pullId: "peer-pull" },
      effectRegistry: registry,
      routes: { echo: offerEntry },
      amendmentRequests: true,
      httpClient,
      urlPolicy: { resolve: async () => ["93.184.216.34"] },
    });
    expect(discovered.foreign.guarantee.level).toBe("reconciled");
    expect(discovered.grantSet.digest).toMatch(/^[0-9a-f]{64}$/);
    const start = createPeerStartRequest({
      pin: discovered,
      parts: [{ text: "review this" }],
    });
    expect(callPeerAgent(discovered, start)).toMatchObject({
      id: "sweatpants.callee-authoritative-peer-adapter",
    });
    expect(() =>
      verifyPeerTaskEcho(
        {
          id: "peer-task",
          status: { state: "working" },
          artifacts: [],
          metadata: {
            [SWEATPANTS_PEER_PROFILE_URI]: {
              grantSetDigest: discovered.grantSet.digest,
              requirementManifestDigest: discovered.requirementManifest.manifestDigest,
            },
          },
        },
        discovered,
      ),
    ).not.toThrow();
  });
});

describe("peer terminal evidence", () => {
  it("signs and verifies disclosed causal evidence without claiming program correctness", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const evidence = createPeerTerminalEvidence(
      {
        taskId: "peer-task",
        calleeReleaseDigest: "a".repeat(64),
        protocolVersion: 1,
        terminalState: "completed",
        resultDigest: "b".repeat(64),
        grantChainHead: grants.digest,
        delegatedEffectTranscriptHead: "c".repeat(64),
        calleeJournalRoot: "d".repeat(64),
        keyId: "peer-key-1",
      },
      privateKey,
    );
    expect(verifyPeerTerminalEvidence(evidence, publicKey)).toMatchObject({ signed: true });
    expect(() =>
      verifyPeerTerminalEvidence({ ...evidence, resultDigest: "e".repeat(64) }, publicKey),
    ).toThrowError(expect.objectContaining({ code: "peer_terminal_evidence_invalid" }));
  });
});

function peerPin(): PeerInvocationPin {
  return {
    foreign: foreignPin(),
    calleeIdentity: "callee-peer",
    requirementManifest: requirement,
    grantSet: grants,
    profile: {
      protocolVersion: 1,
      delegatedEffectsVersion: 1,
      requirementManifestEndpoint: "https://callee.example/requirements",
      delegatedEffectsEndpoint: "https://callee.example/delegated-effects",
      retention,
    },
    retentionExpiresAt: Object.fromEntries(
      Object.keys(retention).map((key) => [key, new Date(Date.now() + 3600_000).toISOString()]),
    ) as PeerInvocationPin["retentionExpiresAt"],
  };
}
function foreignPin(): ForeignA2AInvocationPin {
  return {
    cardDigest: "a".repeat(64),
    agentName: "callee-peer",
    skillId: "peer-review",
    interface: {
      url: "https://callee.example/a2a",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
    },
    extensionUris: [DURABLE_INVOCATION_EXTENSION_URI],
    guarantee: {
      level: "reconciled",
      source: "durable_invocation_extension",
      negotiatedAt: new Date().toISOString(),
      invocationExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      messageIdempotencyExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      extension: {
        protocolVersion: 1,
        resolveEndpoint: "https://callee.example/invocations:resolve",
        abortEndpoint: "https://callee.example/invocations:abort",
        messageIdempotency: true,
        retention: {
          invocationBindingSeconds: 3600,
          abortTombstoneSeconds: 3600,
          messageIdempotencySeconds: 3600,
          taskSeconds: 3600,
          terminalResultSeconds: 3600,
          clockSkewSeconds: 5,
        },
      },
    },
    ambiguityPolicy: "surface",
    invocationId: "peer-invocation",
    initialMessageId: "peer-message",
    requestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    principalId: "caller-peer",
  };
}
