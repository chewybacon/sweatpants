import { describe, expect, it } from "vitest";
import {
  assertKernelCompatibility,
  KernelCompatibilityError,
  type KernelIdentity,
  type WorkflowProgram,
  type KernelSnapshot,
} from "../index.ts";
const identity: KernelIdentity = {
  kind: "hoot",
  version: "build-1",
  programFormat: "instructions-1",
  snapshotFormat: "continuation-1",
};
const program: WorkflowProgram = { digest: "program-1", kernel: identity, code: [] };
const snapshot: KernelSnapshot = { kernel: identity, programDigest: program.digest, state: {} };
describe("exact kernel compatibility", () => {
  it("accepts matching program and snapshot identities", () => {
    expect(() => assertKernelCompatibility(identity, program, snapshot)).not.toThrow();
  });
  it.each(["kind", "version", "programFormat", "snapshotFormat"] as const)(
    "rejects a different program %s",
    (field) => {
      expect(() =>
        assertKernelCompatibility(identity, {
          ...program,
          kernel: { ...identity, [field]: "different" },
        }),
      ).toThrow(KernelCompatibilityError);
    },
  );
  it.each(["kind", "version", "programFormat", "snapshotFormat"] as const)(
    "rejects a different snapshot %s",
    (field) => {
      expect(() =>
        assertKernelCompatibility(identity, program, {
          ...snapshot,
          kernel: { ...identity, [field]: "different" },
        }),
      ).toThrow(KernelCompatibilityError);
    },
  );
  it("rejects a snapshot of another program", () => {
    expect(() =>
      assertKernelCompatibility(identity, program, { ...snapshot, programDigest: "other" }),
    ).toThrow(KernelCompatibilityError);
  });
  it("does not claim to verify artifact contents", () => {
    expect(() =>
      assertKernelCompatibility(identity, { ...program, code: ["different"] }),
    ).not.toThrow();
  });
});
