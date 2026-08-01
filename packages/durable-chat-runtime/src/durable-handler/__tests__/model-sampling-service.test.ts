import { describe, expect, it } from "vitest";
import { safeProviderErrorMessage } from "../model-sampling/service.ts";

describe("model sampling provider error projection", () => {
  it("redacts bearer, basic, named credentials, and sk-style keys", () => {
    const projected = safeProviderErrorMessage(
      "Bearer bearer-secret Basic dXNlcjpwYXNz token: tok-secret api_key=key-secret sk-projected-secret",
    );
    expect(projected).not.toContain("bearer-secret");
    expect(projected).not.toContain("dXNlcjpwYXNz");
    expect(projected).not.toContain("tok-secret");
    expect(projected).not.toContain("key-secret");
    expect(projected).not.toContain("sk-projected-secret");
    expect(projected).toContain("Bearer [redacted]");
    expect(projected).toContain("Basic [redacted]");
  });
});
