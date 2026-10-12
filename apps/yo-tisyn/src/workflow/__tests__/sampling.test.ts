import { describe, expect, it } from "vitest";
import { run } from "effection";
import { createTisynTool, parseProgram, validateProgram } from "../tisyn.ts";
import { sample } from "../tools/sample.ts";
import { sampleText, samplingParameters } from "../sampling.ts";

describe("Tisyn sampling capability", () => {
  it("returns actionable preflight diagnostics without executing effects", async () => {
    const tool = createTisynTool([]).samples().build();
    const context = new Proxy(
      {},
      {
        get() {
          throw new Error("Preflight accessed execution context");
        },
      },
    );
    const result = await run(() =>
      tool.program(
        { program: 'Eval("sample", {"prompt":"a color"})', validateOnly: true },
        context as Parameters<typeof tool.program>[1],
      ),
    );
    expect(result).toEqual({ status: "valid", executed: false });
    expect(validateProgram('Let("x",1)', [])).toEqual({
      status: "invalid",
      executed: false,
      diagnostic: expect.stringContaining("Let"),
    });
    expect(validateProgram('Eval("shell",{})', [])).toEqual({
      status: "invalid",
      executed: false,
      diagnostic: expect.stringContaining("Unsupported"),
    });
  });

  it("opts into native sampling without installing a child tool", () => {
    const disabled = createTisynTool([]).build();
    const direct = createTisynTool([]).samples().build();
    const child = createTisynTool([sample]).build();
    expect(disabled.manifest.pulls?.sample).toBeUndefined();
    expect(child.manifest.pulls?.sample).toBeUndefined();
    expect(direct.manifest.pulls?.sample).toBeDefined();
    expect(sample.manifest.pulls?.sample).toBeDefined();
    expect(direct.description).toBe(child.description);
    expect(new Set([disabled, direct, child].map((tool) => tool.manifest.digest)).size).toBe(3);
  });

  it("admits sampling only when declared and rejects ambiguous dispatch", () => {
    const source = 'Eval("sample",{"prompt":"Return a color"})';
    expect(() => parseProgram(source, [])).toThrow("Unsupported");
    expect(parseProgram(source, [], true)).toEqual(parseProgram(source, [sample]));
    expect(() => createTisynTool([sample]).samples().build()).toThrow("Duplicate");
  });

  it("forwards authored instructions without adding task context", async () => {
    const requests: unknown[] = [];
    const result = await run(() =>
      sampleText(
        { prompt: "Return a color" },
        {
          *sample(request) {
            requests.push(request);
            return { text: "blue" };
          },
        },
      ),
    );
    expect(requests).toEqual([{ prompt: "Return a color", maxTokens: 1024 }]);
    expect(result).toEqual({ text: "blue" });
  });

  it("bounds inputs identically for both sampling paths", () => {
    expect(samplingParameters.safeParse({ prompt: "", maxTokens: 1 }).success).toBe(false);
    expect(samplingParameters.safeParse({ prompt: "hello", maxTokens: 4097 }).success).toBe(false);
    expect(samplingParameters.safeParse({ prompt: "x".repeat(32_769) }).success).toBe(false);
    expect(samplingParameters.safeParse({ prompt: "hello", maxTokens: 4096 }).success).toBe(true);
  });
});
