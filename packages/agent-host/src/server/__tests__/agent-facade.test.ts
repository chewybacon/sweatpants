import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { run } from "effection";
import { advertiseCapability, defineAgent } from "@sweatpants/agent-sdk";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import { canonicalJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  DELEGATED_EFFECTS_EXTENSION_URI,
  SWEATPANTS_PEER_PROFILE_URI,
  createRemoteProgramManifestDocument,
  type A2AHttpClient,
} from "@sweatpants/a2a";
import {
  createChatModelEffectRegistration,
  defineChatProgram,
  type AuthoredChatModelSampleResult,
} from "@sweatpants/chat-core";
import {
  assertRemoteReferenceUsable,
  connectPeerAgent,
  connectRemoteExecutor,
  connectStandardAgent,
  agentCardSigningProjection,
  createAgentCardJwsSigner,
  createDurableRemoteReference,
  createStandardA2AHost,
  remoteExecutor,
  requireRemoteExecutorHandle,
  serveAgent,
  standardA2A,
  sweatpantsPeer,
} from "../index.ts";

const chat = defineChatProgram({
  identity: { name: "facade.chat", version: "1" },
  systemPrompt: { text: "Be useful", classification: "public" },
});
const definition = defineAgent({
  identity: { name: "facade-agent", version: "1" },
  description: "Facade test agent",
  conversation: chat,
  programs: { chat },
  advertisedCapabilities: {
    chat: advertiseCapability({
      id: "chat",
      name: "Chat",
      description: "Converses",
      tags: ["chat"],
      examples: ["Hello"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      authorization: "chat-users",
    }),
  },
});
const deployment = { interfaceUrl: "https://agent.example.test/a2a" } as const;
const remoteProfile = remoteExecutor({
  deployment: {
    ...deployment,
    manifestEndpoint: "https://agent.example.test/manifests",
    driverEndpoint: "wss://agent.example.test/driver",
  },
  bindings: { chat: "chat" },
});
const peerProfile = sweatpantsPeer({
  deployment: {
    ...deployment,
    requirementManifestEndpoint: "https://agent.example.test/peer/requirements",
    delegatedEffectsEndpoint: "https://agent.example.test/peer/effects",
    durableInvocation: {
      protocolVersion: 1,
      resolveEndpoint: "https://agent.example.test/invocations/resolve",
      abortEndpoint: "https://agent.example.test/invocations/abort",
      messageIdempotency: true,
      retention: {
        invocationBindingSeconds: 3600,
        abortTombstoneSeconds: 3600,
        messageIdempotencySeconds: 3600,
        taskSeconds: 3600,
        terminalResultSeconds: 3600,
        clockSkewSeconds: 30,
      },
    },
    retention: {
      taskSeconds: 3600,
      invocationBindingSeconds: 3600,
      effectEventSeconds: 3600,
      grantSeconds: 3600,
      effectResponseSeconds: 3600,
      cancellationEvidenceSeconds: 3600,
      terminalEvidenceSeconds: 3600,
    },
  },
  bindings: { chat: "chat" },
  effects: { "chat.model.sample": { route: "caller" } },
});
const publicUrlPolicy = { resolve: async () => ["93.184.216.34"] };
function jsonClient(body: Json, extensions: string): A2AHttpClient {
  const request = async (input: { readonly url: string | URL }) => ({
    url: input.url instanceof URL ? input.url : new URL(input.url),
    status: 200,
    headers: { "a2a-extensions": extensions },
    body: new TextEncoder().encode(canonicalJson(body)),
  });
  return { get: request, request };
}

const modelHandler = createChatModelEffectRegistration({
  allowedClassifications: ["public"],
  *sample(): Generator<never, AuthoredChatModelSampleResult, never> {
    return {
      message: {
        id: "answer",
        role: "assistant",
        parts: [{ value: "ok", provenance: { classifications: [], sourceDigests: [] } }],
      },
      calls: [],
      artifacts: [],
    };
  },
});

describe("agent serving facade", () => {
  it("compiles caller-authoritative cards and exact registries", () => {
    const served = serveAgent(definition, remoteProfile);
    expect(served.posture).toBe("remote-executor");
    expect(served.readiness).toBe(true);
    expect(served.selfCheck().ok).toBe(true);
    expect(Object.values(served.manifests)[0]?.program.digest).toBe(chat.manifest.digest);
    expect(JSON.stringify(served.card)).not.toContain("Be useful");
    expect(served.card).toHaveProperty("supportedInterfaces");
    expect(served.card).toHaveProperty("url", deployment.interfaceUrl);
    expect(served.card).toHaveProperty("preferredTransport", "HTTP+JSON");
    expect(served.card).not.toHaveProperty("protocolVersion");
  });

  it("preflights standard local effects and requires a real host for readiness", () => {
    const descriptorOnly = serveAgent(
      definition,
      standardA2A({ deployment, handlers: [modelHandler], capabilityBindings: {} }),
    );
    expect(descriptorOnly.readiness).toBe(false);
    const hosted = serveAgent(
      definition,
      standardA2A({
        deployment,
        handlers: [modelHandler],
        capabilityBindings: {},
        host: createStandardA2AHost({ allowAnonymousDevelopment: true }),
      }),
    );
    expect(hosted.readiness).toBe(true);
    expect(hosted.selfCheck().ok).toBe(true);
    expect(() =>
      serveAgent(definition, standardA2A({ deployment, handlers: [], capabilityBindings: {} })),
    ).toThrowError(expect.objectContaining({ code: "effect_route_missing" }));
  });

  it("signs the canonical Agent Card without putting keys in agent identity", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = serveAgent(
      definition,
      standardA2A({
        deployment: {
          ...deployment,
          cardSigner: createAgentCardJwsSigner({
            algorithm: "EdDSA",
            keyId: "fixture-key",
            privateKey,
          }),
        },
        handlers: [modelHandler],
        capabilityBindings: {},
        host: createStandardA2AHost({ allowAnonymousDevelopment: true }),
      }),
    );
    const card = signed.card as Record<string, Json>;
    const signature = (card["signatures"] as Array<Record<string, Json>>)[0]!;
    const { signatures: _signatures, ...unsigned } = card;
    const payload = Buffer.from(
      canonicalJson(agentCardSigningProjection(unsigned as Json)),
      "utf8",
    ).toString("base64url");
    const signingInput = Buffer.from(`${signature["protected"]}.${payload}`, "ascii");
    expect(
      verify(
        null,
        signingInput,
        publicKey,
        Buffer.from(String(signature["signature"]), "base64url"),
      ),
    ).toBe(true);
    const tampered = { ...unsigned, description: "tampered" } as Json;
    const tamperedPayload = Buffer.from(
      canonicalJson(agentCardSigningProjection(tampered)),
      "utf8",
    ).toString("base64url");
    expect(
      verify(
        null,
        Buffer.from(`${signature["protected"]}.${tamperedPayload}`, "ascii"),
        publicKey,
        Buffer.from(String(signature["signature"]), "base64url"),
      ),
    ).toBe(false);
    expect(JSON.stringify(definition.manifest)).not.toContain("fixture-key");
  });

  it("validates typed and dynamic posture-specific connection evidence", async () => {
    const remoteServed = serveAgent(definition, remoteProfile);
    const remoteDocument = Object.values(remoteServed.manifests).find(
      (document) => document.program.digest === chat.manifest.digest,
    )!;
    const remoteHttp = jsonClient(
      remoteDocument as unknown as Json,
      CALLER_AUTHORITATIVE_EXTENSION_URI,
    );
    const remote = await run(() =>
      connectRemoteExecutor({
        source: { card: remoteServed.card, cardOrigin: "https://agent.example.test" },
        expected: {
          agent: definition.manifest,
          capabilityId: "chat",
          entrypoint: "chat",
          program: definition.bindings.programs["chat"]!,
        },
        httpClient: remoteHttp,
        urlPolicy: publicUrlPolicy,
      }),
    );
    expect(remote.posture).toBe("remote-executor");
    expect(remote.manifest.manifest.inputSchema.digest).toBe(chat.manifest.inputSchema.digest);
    const dynamic = await run(() =>
      connectRemoteExecutor({
        source: { card: remoteServed.card, cardOrigin: "https://agent.example.test" },
        capabilityId: "chat",
        httpClient: remoteHttp,
        urlPolicy: publicUrlPolicy,
      }),
    );
    expect(dynamic.program.digest).toBe(chat.manifest.digest);
    const driftedDocument = createRemoteProgramManifestDocument({
      ...chat.manifest,
      capabilities: { ...chat.manifest.capabilities, durableEmissions: false },
    });
    await expect(
      run(() =>
        connectRemoteExecutor({
          source: { card: remoteServed.card, cardOrigin: "https://agent.example.test" },
          expected: {
            agent: definition.manifest,
            capabilityId: "chat",
            entrypoint: "chat",
            program: definition.bindings.programs["chat"]!,
          },
          httpClient: jsonClient(
            driftedDocument as unknown as Json,
            CALLER_AUTHORITATIVE_EXTENSION_URI,
          ),
          urlPolicy: publicUrlPolicy,
        }),
      ),
    ).rejects.toMatchObject({ code: "remote_contract_mismatch" });

    const standard = await run(() =>
      connectStandardAgent({
        source: { card: remoteServed.card, cardOrigin: "https://agent.example.test" },
        skillId: "chat",
        principalId: "principal",
        minimumGuarantee: "task_handle_only",
        urlPolicy: publicUrlPolicy,
        expected: {
          agentName: definition.manifest.identity.name,
          capabilityId: "chat",
          cardDigest: canonicalSnapshot(remoteServed.card).sha,
        },
      }),
    );
    expect(standard.posture).toBe("standard-a2a");
    expect(() => requireRemoteExecutorHandle(standard as never)).toThrowError(
      expect.objectContaining({ code: "remote_posture_mismatch" }),
    );
    await expect(
      run(() =>
        connectStandardAgent({
          source: { card: remoteServed.card, cardOrigin: "https://agent.example.test" },
          skillId: "chat",
          principalId: "principal",
          minimumGuarantee: "task_handle_only",
          urlPolicy: publicUrlPolicy,
          expected: { cardDigest: "0".repeat(64) },
        }),
      ),
    ).rejects.toMatchObject({ code: "remote_contract_mismatch" });
  });

  it("connects a peer only after exact requirement and caller-handler preflight", async () => {
    const peerServed = serveAgent(definition, peerProfile);
    const requirement = peerServed.requirements["chat"]!;
    const peer = await run(() =>
      connectPeerAgent({
        source: { card: peerServed.card, cardOrigin: "https://agent.example.test" },
        skillId: "chat",
        principalId: "caller",
        derivationKey: "peer-derivation-key-with-at-least-32-bytes",
        localIdentity: { taskId: "local-task" },
        calleeIdentity: "facade-agent",
        effectRegistry: createDurableEffectRegistry([modelHandler]),
        routes: {
          "chat.model.sample": {
            contractDigest: requirement.requirements[0]!.contract.contractDigest,
            route: "caller",
            delegation: { mode: "none" },
          },
        },
        httpClient: jsonClient(
          requirement as unknown as Json,
          `${SWEATPANTS_PEER_PROFILE_URI}, ${DELEGATED_EFFECTS_EXTENSION_URI}`,
        ),
        urlPolicy: publicUrlPolicy,
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    );
    expect(peer.posture).toBe("sweatpants-peer");
    expect(peer.pin.requirementManifest.manifestDigest).toBe(requirement.manifestDigest);
  });

  it("round-trips redacted remote references and rejects posture, expiry, and secret fields", () => {
    const reference = createDurableRemoteReference({
      format: "sweatpants.remote-reference.v1",
      posture: "remote-executor",
      cardDigest: "a".repeat(64),
      interface: { url: deployment.interfaceUrl, protocolBinding: "HTTP+JSON" },
      capabilityId: "chat",
      program: {
        id: chat.manifest.programId,
        version: chat.manifest.version,
        digest: chat.manifest.digest,
      },
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(createDurableRemoteReference(reference)).toEqual(reference);
    expect(JSON.stringify(reference)).not.toContain("Bearer");
    expect(() => assertRemoteReferenceUsable(reference, "standard-a2a")).toThrowError(
      expect.objectContaining({ code: "remote_posture_mismatch" }),
    );
    expect(() =>
      assertRemoteReferenceUsable(
        { ...reference, expiresAt: "2000-01-01T00:00:00.000Z" },
        "remote-executor",
      ),
    ).toThrowError(expect.objectContaining({ code: "remote_pin_expired" }));
    let redactedError: unknown;
    try {
      createDurableRemoteReference({
        ...reference,
        authorization: "Bearer TOP_SECRET",
      } as never);
    } catch (error) {
      redactedError = error;
    }
    expect(redactedError).toMatchObject({ code: "remote_contract_mismatch" });
    expect(JSON.stringify(redactedError)).not.toContain("TOP_SECRET");
  });

  it("compiles one immutable definition under all profiles without changing its digest", () => {
    const before = definition.manifest.identity.digest;
    const remote = serveAgent(definition, remoteProfile);
    const standard = serveAgent(
      definition,
      standardA2A({ deployment, handlers: [modelHandler], capabilityBindings: {} }),
    );
    const peer = serveAgent(definition, peerProfile);
    expect([remote.definition, standard.definition, peer.definition]).toEqual([
      definition,
      definition,
      definition,
    ]);
    expect(definition.manifest.identity.digest).toBe(before);
  });

  it("derives peer requirement manifests without grants in agent identity", () => {
    const before = definition.manifest.identity.digest;
    const served = serveAgent(definition, peerProfile);
    expect(served.selfCheck().ok).toBe(true);
    expect(served.requirements["chat"]?.requirements[0]?.contract.name).toBe("chat.model.sample");
    expect(definition.manifest.identity.digest).toBe(before);
    expect(JSON.stringify(definition.manifest)).not.toContain("grant");
  });
});
