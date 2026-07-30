import { describe, expect, it } from "vitest";
import {
  inspectAcceptanceBoundarySource,
  scanAcceptanceBoundaryStyle,
} from "../acceptance-boundary-style.ts";

describe("acceptance boundary style", () => {
  it("keeps repository acceptance tests on installed boundaries", () => {
    expect(scanAcceptanceBoundaryStyle()).toEqual([]);
  });

  it("rejects static module replacement", () => {
    expect(inspectAcceptanceBoundarySource('vi.mock("vendor-client", () => ({}));')).toEqual([
      expect.objectContaining({ rule: "static-module-mock" }),
    ]);
  });

  it("rejects hand-built providers and package test internals", () => {
    const source = `
      import { createMockProvider } from "../src/__tests__/test-utils.ts";
      const provider = createMockProvider({ responses: "hello" });
    `;
    expect(inspectAcceptanceBoundarySource(source).map((entry) => entry.rule)).toEqual([
      "mock-provider",
      "test-internal-import",
    ]);
  });

  it("allows a reviewed exception only with a substantive rationale", () => {
    const source = `
      // boundary-simulator-escape-hatch: browser module loading cannot be served by the Node protocol simulator
      vi.mock("virtual:browser-module", () => ({}));
    `;
    expect(inspectAcceptanceBoundarySource(source)).toEqual([]);
    expect(
      inspectAcceptanceBoundarySource(
        `// boundary-simulator-escape-hatch: temporary\nvi.mock("vendor", () => ({}));`,
      ),
    ).toHaveLength(1);
  });
});
