import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanAuthoredSchemaRederivation } from "../authored-schema-projection-style.ts";

describe("authored schema projection style", () => {
  it("does not re-derive authored tool parameters in production", () => {
    expect(scanAuthoredSchemaRederivation()).toEqual([]);
  });

  it("rejects both supported forms of downstream parameter re-derivation", () => {
    const directory = mkdtempSync(join(tmpdir(), "authored-schema-projection-"));
    const direct = join(directory, "direct.ts");
    const zod = join(directory, "zod.ts");
    try {
      writeFileSync(direct, "toToolParameterJsonSchema(tool.parameters);\n");
      writeFileSync(zod, "z.toJSONSchema(contract.parameters);\n");
      expect(
        scanAuthoredSchemaRederivation([direct, zod]).map((entry) => entry.expression),
      ).toEqual([
        "toToolParameterJsonSchema(tool.parameters)",
        "z.toJSONSchema(contract.parameters)",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows conversion where a schema is actually authored at call time", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-schema-projection-"));
    const file = join(directory, "runtime.ts");
    try {
      writeFileSync(
        file,
        [
          "toToolParameterJsonSchema(sample.inputSchema);",
          "toToolParameterJsonSchema(config.schema);",
          "function defineTool(def: { parameters: unknown }) {",
          "  return { ...def, inputSchema: z.toJSONSchema(def.parameters) };",
          "}",
        ].join("\n"),
      );
      expect(scanAuthoredSchemaRederivation([file])).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
