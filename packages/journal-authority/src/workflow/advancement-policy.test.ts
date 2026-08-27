import { describe, expect, it } from "vitest";

import { livePlacement } from "./advancement-policy.ts";

describe("advancement placement policy", () => {
  it("uses the registered evaluator class for an otherwise opaque driver kind", () => {
    expect(livePlacement({ driverKind: "workspace" }, undefined, "remote")).toMatchObject({
      evaluatorKind: "remote",
      route: { kind: "remote", driverKind: "workspace" },
    });
  });

  it("rejects peer evaluators at the local activation boundary", () => {
    expect(() => livePlacement({ driverKind: "peer-driver" }, undefined, "peer")).toThrow(
      /cannot be activated by a local driver/,
    );
  });
});
