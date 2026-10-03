import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  markdown,
  math,
  mermaid,
  preloadProcessors,
  runPipelineStreaming,
  shiki,
} from "@sweatpants/frame-renderer";
import type { Frame } from "@sweatpants/frame-renderer";

const markdownFixture = `# Rendering fixture

This paragraph has *italic text* and **bold text**.

- alpha item
- beta item
`;

const mathFixture = `# Math fixture

Inline math: $E = mc^2$.

Block math:

$$
\\int_0^1 x^2 dx = \\frac{1}{3}
$$
`;

const mermaidFixture = `# Mermaid fixture

\`\`\`mermaid
graph TD
  A[Start] --> B[Render Markdown]
  B --> C[Done]
\`\`\`
`;

function renderedHtml(final: Frame): string {
  return final.blocks.map((block) => block.rendered).join("\n");
}

describe("@sweatpants/react-chat rendering pipeline acceptance", () => {
  it("renders streamed markdown frames to stable HTML", async () => {
    const { final } = await run(function* () {
      return yield* runPipelineStreaming(markdownFixture, { processors: [markdown] });
    });
    const html = renderedHtml(final);

    expect(html).toContain("<h1>Rendering fixture</h1>");
    expect(html).toContain("<em>italic text</em>");
    expect(html).toContain("<strong>bold text</strong>");
    expect(html).toContain("<li>alpha item</li>");
    expect(html).not.toContain("**bold text**");
  });

  it("renders streamed KaTeX math frames to stable HTML", async () => {
    const { final } = await run(function* () {
      return yield* runPipelineStreaming(mathFixture, { processors: [markdown, math] });
    });
    const html = renderedHtml(final);

    expect(html).toContain("<h1>Math fixture</h1>");
    expect(html).toContain('class="katex');
    expect(html).toContain('class="katex-display');
    expect(html).not.toContain("$$");
  });

  it("preserves streamed mermaid frames as renderable diagram blocks without raw fences", async () => {
    const { final } = await run(function* () {
      yield* preloadProcessors([markdown, shiki, mermaid]);
      return yield* runPipelineStreaming(mermaidFixture, {
        processors: [markdown, shiki, mermaid],
      });
    });
    const html = renderedHtml(final);

    expect(html).toContain("<h1>Mermaid fixture</h1>");
    expect(html).toContain("language-mermaid");
    expect(html).toContain("graph");
    expect(html).not.toContain("```mermaid");
  });

  it("keeps independently rendered turn frames intact across a multi-turn sequence", async () => {
    const [markdownTurn, mathTurn, mermaidTurn] = await run(function* () {
      const first = yield* runPipelineStreaming(markdownFixture, { processors: [markdown] });
      const second = yield* runPipelineStreaming(mathFixture, { processors: [markdown, math] });
      yield* preloadProcessors([markdown, shiki, mermaid]);
      const third = yield* runPipelineStreaming(mermaidFixture, {
        processors: [markdown, shiki, mermaid],
      });
      return [first.final, second.final, third.final] as const;
    });

    const markdownHtml = renderedHtml(markdownTurn);
    const mathHtml = renderedHtml(mathTurn);
    const mermaidHtml = renderedHtml(mermaidTurn);

    expect(markdownHtml).toContain("<strong>bold text</strong>");
    expect(markdownHtml).toContain("<li>beta item</li>");
    expect(mathHtml).toContain('class="katex');
    expect(mathHtml).toContain('class="katex-display');
    expect(mermaidHtml).toContain("language-mermaid");
    expect(mermaidHtml).not.toContain("```mermaid");
  });
});
