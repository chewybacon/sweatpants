import { describe, expect, it } from "vitest";

import { cliProgram } from "../cli-config.ts";

describe("CLI configuration", () => {
  it("parses generate options and boolean switches", () => {
    const result = cliProgram.parse({
      args: [
        "generate",
        "--input",
        "https://example.test/manifest.json",
        "--output",
        "generated.ts",
        "--no-header",
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        config: {
          name: "generate",
          config: {
            input: "https://example.test/manifest.json",
            output: "generated.ts",
            noHeader: true,
          },
        },
      },
    });
  });

  it("parses short aliases and reports command help", () => {
    const result = cliProgram.parse({ args: ["generate", "-i", "manifest.json", "-o", "out.ts"] });
    expect(result).toMatchObject({
      ok: true,
      value: {
        config: {
          name: "generate",
          config: { input: "manifest.json", output: "out.ts", noHeader: false },
        },
      },
    });

    const help = cliProgram.parse({ args: ["generate", "--help"] });
    expect(help).toMatchObject({
      ok: true,
      value: { config: { name: "generate", help: true } },
    });
  });

  it("fails when a required option is missing", () => {
    const result = cliProgram.parse({ args: ["generate", "--input", "manifest.json"] });
    expect(result.ok).toBe(false);
  });
});
