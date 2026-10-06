import { describe, expect, it } from "vitest";
import { dependencyBuildArgs } from "../dev-app.ts";
import { readMode } from "../dev-options.ts";

describe("development launch preparation", () => {
  it("selects the transitive dependencies without recursively building the app", () => {
    expect(dependencyBuildArgs("yo-chat")).toContain("yo-chat^...");
    expect(() => dependencyBuildArgs("missing")).toThrow("Unknown development app");
  });

  it.each([["--mode", "cloudflare"], ["--mode=cloudflare"], ["-m", "cloudflare"]])(
    "recognizes Cloudflare mode: %j",
    (...args) => expect(readMode(args)).toBe("cloudflare"),
  );
  it("rejects missing mode values and honors the final explicit mode", () => {
    expect(() => readMode(["--mode", "--port", "8000"])).toThrow();
    expect(() => readMode(["--mode="])).toThrow();
    expect(readMode(["--mode", "cloudflare", "--mode=d1-local"])).toBe("d1-local");
  });
});
