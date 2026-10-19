import { describe, expect, it } from "vitest";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createKernelProgramBundle, loadKernelProgram } from "../program.ts";

const identity = {
  kind: "hoot",
  version: "build",
  programFormat: "scheme",
  snapshotFormat: "state",
};
const contract = {
  programId: "review",
  version: "1",
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  effects: {},
  elicits: {},
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" as const },
};

describe("kernel program bundle", () => {
  it("pins code, runtime identity and contract and loads detached data", () => {
    const payload = { instructions: ["yield"] };
    const bundle = createKernelProgramBundle({ format: "scheme", payload }, identity, contract);
    payload.instructions.push("mutated");
    const loaded = loadKernelProgram(bundle, bundle.manifest.digest);
    expect(loaded).toEqual(bundle.artifact);
    expect(loaded).not.toBe(bundle.artifact);
    expect(loaded.code).toEqual({ instructions: ["yield"] });
    expect(loaded.kernel).not.toBe(bundle.artifact.kernel);
  });
  it("rejects a format before producing an artifact", () => {
    expect(() =>
      createKernelProgramBundle({ format: "rune", payload: "code" }, identity, contract),
    ).toThrow(/format/);
  });
  it("rejects modified code, identity, manifest and claimed digests", () => {
    const bundle = createKernelProgramBundle(
      { format: "scheme", payload: "code" },
      identity,
      contract,
    );
    const candidates = [
      { ...bundle, artifact: { ...bundle.artifact, code: "changed" } },
      { ...bundle, artifact: { ...bundle.artifact, digest: "changed" } },
      { ...bundle, artifact: { ...bundle.artifact, kernel: { ...identity, version: "changed" } } },
      { ...bundle, manifest: { ...bundle.manifest, version: "changed" } },
      { ...bundle, manifest: { ...bundle.manifest, digest: "changed" } },
    ];
    for (const candidate of candidates) {
      expect(() => loadKernelProgram(candidate, bundle.artifact.digest)).toThrow(/digest differs/);
    }
    expect(() => loadKernelProgram(bundle, "wrong")).toThrow(/digest differs/);
  });
});
