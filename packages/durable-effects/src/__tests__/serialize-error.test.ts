import { canonicalSnapshot } from "@sweatpants/foundation";
import { describe, expect, it } from "vitest";
import { serializeEffectError } from "../serialize-error.ts";

describe("effect error serialization", () => {
  it.each([undefined, { nested: undefined }, 1n, "x".repeat(64 * 1024)])(
    "omits invalid or oversized details without losing the failure",
    (details) => {
      const error = Object.assign(new Error("failed"), { code: "test_failure", details });
      const result = serializeEffectError(error);

      expect(result).toStrictEqual({ code: "test_failure", message: "failed" });
      expect(Object.hasOwn(result, "details")).toBe(false);
      expect(() => canonicalSnapshot(result)).not.toThrow();
    },
  );

  it.each([null, false, 0, "", { nested: [1, "two"] }])(
    "preserves valid details, including falsy values: %j",
    (details) => {
      const result = serializeEffectError(Object.assign(new Error("failed"), { details }));

      expect(result).toStrictEqual({ code: "effect_failed", message: "failed", details });
      expect(() => canonicalSnapshot(result)).not.toThrow();
    },
  );

  it("detaches details from the thrown object's mutable state", () => {
    const details = { nested: [1] };
    const result = serializeEffectError({ details });
    details.nested.push(2);

    expect(result.details).toEqual({ nested: [1] });
  });

  it("records thrown primitives without inventing details", () => {
    expect(serializeEffectError(null)).toStrictEqual({
      code: "effect_failed",
      message: "Durable effect failed",
    });
  });
});
