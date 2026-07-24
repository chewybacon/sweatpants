import { describe, expect, it } from "vitest";
import type { DurableTool } from "@sweatpants/session-contract";
import {
  requiresFencedActivation,
  type ProgramDriverNativeToolBinding,
  type ProgramDriverNativeToolComposition,
} from "../program-driver-native-tools.ts";

function stubTool(name: string): DurableTool<never, never> {
  return {
    durability: "crank_native",
    manifest: {
      programId: name,
      version: "1.0.0",
      digest: "a".repeat(64),
    },
    program: function* () {
      throw new Error("not executed");
    },
    identityProvenance: { kind: "asserted" },
  } as unknown as DurableTool<never, never>;
}

function composition(
  bindings: Array<Partial<ProgramDriverNativeToolBinding> & { publicName: string }>,
): ProgramDriverNativeToolComposition {
  return {
    bindings: new Map(
      bindings.map((binding) => [
        binding.publicName,
        {
          tool: stubTool(binding.publicName),
          route: { driverKind: "program" },
          ...binding,
        } as ProgramDriverNativeToolBinding,
      ]),
    ),
    drivers: [],
    effects: [],
  };
}

describe("requiresFencedActivation", () => {
  it("is false without any native composition", () => {
    expect(requiresFencedActivation(undefined)).toBe(false);
  });

  it("is false for in-process bindings that declare no activation capability", () => {
    expect(
      requiresFencedActivation(
        composition([
          { publicName: "local_tool", route: { driverKind: "worker" } },
          { publicName: "generator_tool", route: { driverKind: "program" } },
        ]),
      ),
    ).toBe(false);
  });

  it("fences when any binding declares the capability, regardless of vendor name", () => {
    expect(
      requiresFencedActivation(
        composition([
          { publicName: "local_tool", route: { driverKind: "worker" } },
          {
            publicName: "remote_tool",
            // A hypothetical non-AgentCore remote driver: the capability alone
            // must be sufficient. Fencing never depends on a vendor string.
            route: { driverKind: "lambda" },
            activation: "fenced",
          },
        ]),
      ),
    ).toBe(true);
  });

  it("does not infer fencing from the agentcore driverKind string", () => {
    // A binding that *looks* like AgentCore but declares no capability is not
    // fenced. Activation safety is an explicit contract, not a name match.
    expect(
      requiresFencedActivation(
        composition([
          {
            publicName: "undeclared_remote",
            route: { driverKind: "agentcore", journalId: "j1" },
          },
        ]),
      ),
    ).toBe(false);
  });
});
