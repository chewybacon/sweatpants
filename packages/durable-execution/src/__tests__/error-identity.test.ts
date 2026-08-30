import { describe, expect, it } from "vitest";
import { CrankError, PullApplicationError } from "@sweatpants/durable-execution";
import { serializeDurableError } from "@sweatpants/durable-execution";

describe("canonical durable error identity", () => {
  it("preserves coded runtime and expected application failures", () => {
    expect(serializeDurableError(new CrankError("stale_activation", "stale"))).toEqual({
      code: "stale_activation",
      message: "stale",
    });
    expect(
      serializeDurableError(
        new PullApplicationError({ code: "provider_rejected", message: "provider rejected" }),
      ),
    ).toEqual({ code: "provider_rejected", message: "provider rejected" });
  });
});
