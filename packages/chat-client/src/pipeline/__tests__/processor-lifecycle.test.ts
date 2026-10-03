import { run } from "effection";
import { afterEach, expect, it, vi } from "vitest";
import { createPipeline } from "../runner.ts";
import * as mermaidLoader from "../../mermaid/loader.ts";

afterEach(() => vi.restoreAllMocks());

it("keeps Mermaid as source until a complete closing fence, then renders once", async () => {
  // Node has no SVG layout engine. Exercise the processor boundary here;
  // browser validation covers the real Mermaid renderer.
  const render = vi.spyOn(mermaidLoader, "renderMermaid").mockImplementation(function* () {
    return { success: true, svg: '<svg data-test="diagram"></svg>' };
  });
  const pipeline = createPipeline({ processors: "full" });
  pipeline.push("**Diagram**\n\n```mermaid\ngraph TD\n  A[Start] --> B[Done]\n");
  expect(render).not.toHaveBeenCalled();
  const open = await run(() => pipeline.pull());
  const source = open.blocks.find((block) => block.language === "mermaid")!;
  expect(source.status).toBe("streaming");
  expect(source.renderPass).toBe("quick");
  expect(source.rendered).toContain("language-mermaid");
  expect(source.rendered).not.toContain("<svg");
  expect(render).not.toHaveBeenCalled();

  pipeline.push("``");
  await run(() => pipeline.pull());
  expect(render).not.toHaveBeenCalled();
  pipeline.push("`\n");
  const settled = await run(() => pipeline.pull());
  const diagram = settled.blocks.find((block) => block.id === source.id)!;
  expect(diagram.status).toBe("complete");
  expect(diagram.renderPass).toBe("full");
  expect(diagram.rendered).toContain('<svg data-test="diagram">');
  expect(source.rendered).toContain("language-mermaid");
  expect(render).toHaveBeenCalledExactlyOnceWith("graph TD\n  A[Start] --> B[Done]\n");

  pipeline.push("\nFollowing paragraph with $x^2$.\n");
  const next = await run(() => pipeline.pull());
  expect(next.blocks.find((block) => block.id === diagram.id)).toBe(diagram);
  expect(render).toHaveBeenCalledTimes(1);
  expect(next.blocks.at(-1)?.rendered).toContain('class="katex"');
});

it("promotes streaming code to Shiki highlighting without changing its contents", async () => {
  const pipeline = createPipeline({ processors: "full" });
  pipeline.push('```typescript\nconst value: string = "$x$";\n');
  const open = await run(() => pipeline.pull());
  const code = open.blocks[0]!;
  expect(code.status).toBe("streaming");
  expect(code.rendered).toContain("quick-highlight");
  expect(code.rendered).not.toContain('class="katex"');
  pipeline.push("```");
  const settled = await run(() => pipeline.flush());
  const finalCode = settled.blocks[0]!;
  expect(finalCode.status).toBe("complete");
  expect(finalCode.renderPass).toBe("full");
  expect(finalCode.raw).toBe(code.raw);
  expect(finalCode.rendered).toContain('class="shiki');
  expect(finalCode.rendered).not.toContain('class="katex"');
});

it("does not promote an unterminated Mermaid fence on stream completion", async () => {
  const render = vi.spyOn(mermaidLoader, "renderMermaid");
  const pipeline = createPipeline({ processors: "full" });
  pipeline.push("```mermaid\ngraph TD\nA -->");
  const frame = await run(() => pipeline.flush());
  expect(frame.blocks[0]?.status).toBe("streaming");
  expect(frame.blocks[0]?.rendered).toContain("language-mermaid");
  expect(render).not.toHaveBeenCalled();
});
