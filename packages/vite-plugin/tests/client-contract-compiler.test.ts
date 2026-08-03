import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeClientContractSource,
  ClientContractCompilerError,
  generateClientContractModule,
} from "../src/client-contract-compiler.ts";

describe("client contract compiler", () => {
  it("accepts a statically imported makePlugin argument", () => {
    expect(
      analyzeClientContractSource(
        `import { makePlugin } from "@sweatpants/react-chat";
         import { bookFlight } from "./book-flight";
         export const plugin = makePlugin(bookFlight);`,
        "plugin.ts",
      ),
    ).toEqual({ toolBindings: ["bookFlight"], makePluginCalls: 1 });
  });

  it.each(["makePlugin(condition ? first : second)", "makePlugin(loadTool())", "makePlugin({})"])(
    "rejects a dynamic makePlugin input: %s",
    (expression) => {
      expect(() =>
        analyzeClientContractSource(
          `import { makePlugin } from "@sweatpants/react-chat"; ${expression}`,
          "dynamic.ts",
        ),
      ).toThrowError(ClientContractCompilerError);
    },
  );

  it("removes the executable terminal while preserving contract authoring", () => {
    const generated = generateClientContractModule(
      `import { createTool } from "@sweatpants/agent-sdk";
       import { serverOnly } from "./server-only";
       export const tool = createTool("contract").description("contract")
         .parameters({}).execute(serverOnly(SERVER_EXECUTION_SENTINEL));`,
      "tool.ts",
    );
    expect(generated).not.toContain("SERVER_EXECUTION_SENTINEL");
    expect(generated).toContain("createTool");
    expect(generated).toContain("execute");
    expect(generated).not.toContain("server-only");
  });

  it("loads the generated client module and retains authored schema artifacts", async () => {
    const directory = await mkdtemp(join(process.cwd(), "..", "agent-sdk", ".client-contract-"));
    const filename = join(directory, "tool.mjs");
    try {
      const source = `import { createTool } from "@sweatpants/agent-sdk";
        import { z } from "zod";
        import { serverOnly } from "./server-only.mjs";
        export const tool = createTool("generated_contract").description("generated")
          .parameters(z.object({}))
          .elicits({ choose: { response: z.object({ value: z.string() }) } })
          .execute(serverOnly("SERVER_EXECUTION_SENTINEL"));`;
      const generated = generateClientContractModule(source, "tool.ts");
      await writeFile(filename, generated, "utf8");
      const loaded = (await import(pathToFileURL(filename).href)) as {
        tool: { artifacts: { elicits: Record<string, { response: { identity: string } }> } };
      };
      expect(loaded.tool.artifacts.elicits["choose"]?.response.identity).toContain(
        "choose/response",
      );
      expect(await readFile(filename, "utf8")).not.toContain("SERVER_EXECUTION_SENTINEL");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes durable program execution while retaining its contract builder", () => {
    const generated = generateClientContractModule(
      `import { createDurableTool } from "@sweatpants/agent-sdk";
       import { z } from "zod";
       export const tool = createDurableTool("durable-contract").parameters(z.object({}))
         .identity({ version: "1", digest: "${"a".repeat(64)}" })
         .elicits({ choose: z.object({ value: z.string() }) })
         .effects({})
         .execute(() => "DURABLE_SERVER_EFFECT_SENTINEL");`,
      "durable-tool.ts",
    );
    expect(generated).toContain("createDurableTool");
    expect(generated).not.toContain("DURABLE_SERVER_EFFECT_SENTINEL");
    expect(generated).not.toContain("serverEffect");
  });

  it("fails closed for side-effect imports", () => {
    expect(() =>
      generateClientContractModule(
        `import "./server-side-effect"; export const tool = createTool("x").execute(() => null);`,
        "side-effect.ts",
      ),
    ).toThrowError(ClientContractCompilerError);
  });
});
