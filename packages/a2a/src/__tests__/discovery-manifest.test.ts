import { describe, expect, it } from "vitest";
import { canonicalSnapshot } from "@sweatpants/foundation";
import { DURABLE_DRIVER_FIXTURE_TOOLS } from "@sweatpants/journal-authority/testing";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  createRemoteProgramManifestDocument,
  discoverCallerAuthoritativeProgram,
  isSafePublicAddress,
  parseRemoteProgramManifestDocument,
  validateA2AUrl,
} from "../index.ts";

const tool = DURABLE_DRIVER_FIXTURE_TOOLS[0]!;
const program = {
  id: tool.manifest.programId,
  version: tool.manifest.version,
  digest: tool.manifest.digest,
};
const policy = { resolve: async () => ["93.184.216.34"] };

function card() {
  return {
    name: "Review executor",
    version: "1.0.0",
    supportedInterfaces: [{ url: "https://review.example/a2a", protocolBinding: "JSONRPC" }],
    capabilities: {
      extensions: [
        {
          uri: CALLER_AUTHORITATIVE_EXTENSION_URI,
          description: "Pinned caller-authoritative programs",
          required: false,
          params: {
            protocolVersion: 1,
            manifestEndpoint: "https://review.example/manifests",
            driverEndpoint: "wss://review.example/programs",
            programs: [{ skillId: "review", program }],
          },
        },
      ],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{ id: "review", name: "Review", description: "Reviews a design", tags: ["review"] }],
  };
}

describe("A2A discovery and manifests", () => {
  it("discovers the exact same-origin skill mapping from an explicit card", async () => {
    const discovered = await discoverCallerAuthoritativeProgram({
      source: { card: card(), cardOrigin: "https://review.example" },
      urlPolicy: policy,
    });
    expect(discovered.programForSkill("review")).toEqual(program);
    expect(discovered.cardDigest).toBe(canonicalSnapshot(card()).sha);
  });

  it("rejects duplicate skill mappings and cross-origin endpoints", async () => {
    const duplicate = card();
    duplicate.capabilities.extensions[0]!.params.programs.push({ skillId: "review", program });
    await expect(
      discoverCallerAuthoritativeProgram({
        source: { card: duplicate, cardOrigin: "https://review.example" },
        urlPolicy: policy,
      }),
    ).rejects.toMatchObject({ code: "agent_card_invalid" });

    const crossOrigin = card();
    crossOrigin.capabilities.extensions[0]!.params.manifestEndpoint =
      "https://internal.example/manifests";
    await expect(
      discoverCallerAuthoritativeProgram({
        source: { card: crossOrigin, cardOrigin: "https://review.example" },
        urlPolicy: policy,
      }),
    ).rejects.toMatchObject({ code: "unsafe_url" });
  });

  it("validates the closed exact manifest document and digest", () => {
    const document = createRemoteProgramManifestDocument(tool.manifest);
    expect(parseRemoteProgramManifestDocument(document, program).manifest).toEqual(tool.manifest);
    expect(() =>
      parseRemoteProgramManifestDocument({ ...document, unknown: true }, program),
    ).toThrowError(expect.objectContaining({ code: "manifest_mismatch" }));
    expect(() =>
      parseRemoteProgramManifestDocument({ ...document, manifestDigest: "0".repeat(64) }, program),
    ).toThrowError(expect.objectContaining({ code: "manifest_mismatch" }));
  });

  it("blocks private, loopback, link-local, multicast, reserved, and mapped addresses", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.0.2.1",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isSafePublicAddress(address), address).toBe(false);
      await expect(
        validateA2AUrl("https://review.example/card", {
          purpose: "agent-card",
          policy: { resolve: async () => [address] },
        }),
      ).rejects.toMatchObject({ code: "unsafe_url" });
    }
    expect(isSafePublicAddress("93.184.216.34")).toBe(true);
  });
});
