import { run } from "effection";
import { describe, expect, it, vi } from "vitest";
import { createPipeline } from "../runner.ts";
import { getFrameDocument } from "../document.ts";
import * as loader from "../../math/loader.ts";

const source = String.raw`Inline $E=mc^2$, parentheses \(a^2+b^2=c^2\).

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

\[
x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}
\]
`;

describe("semantic math in lazy frames", () => {
  it("renders math in tables whose Markdown escapes differ from their source text", async () => {
    const pipeline = createPipeline({ processors: "math" });
    pipeline.push("| a\\|b | $x$ |\n|---|---|\n| c | $y$ |");
    const frame = await run(() => pipeline.flush());
    const block = frame.blocks[0]!;
    expect(block.rendered).toContain("a|b");
    expect(block.rendered.match(/class="katex"/g)).toHaveLength(2);
    expect(getFrameDocument(block)?.math.map((node) => node.latex)).toEqual(["x", "y"]);
  });

  it("does not split inline code at display delimiters or treat link destinations as math", async () => {
    const raw = "Code `$$x^2$$` and `\\[x\\]`. [label](https://example.com/$x$)$x$";
    const pipeline = createPipeline({ processors: "math" });
    pipeline.push(raw);
    const frame = await run(() => pipeline.flush());
    const block = frame.blocks[0]!;
    expect(block.rendered).toContain("<code>$$x^2$$</code>");
    expect(block.rendered).toContain("<code>\\[x\\]</code>");
    expect(getFrameDocument(block)?.math).toMatchObject([{ raw: "$x$" }]);
    expect(getFrameDocument(block)?.math).toHaveLength(1);
  });

  it("is independent of transport chunk boundaries", async () => {
    const baseline = createPipeline({ processors: "math" });
    baseline.push(source);
    const expected = (await run(() => baseline.flush())).blocks.map((block) => block.rendered);
    for (let split = 1; split < source.length; split++) {
      const pipeline = createPipeline({ processors: "math" });
      pipeline.push(source.slice(0, split));
      await run(() => pipeline.pull());
      pipeline.push(source.slice(split));
      const frame = await run(() => pipeline.flush());
      expect(
        frame.blocks.map((block) => block.rendered),
        `split ${split}`,
      ).toEqual(expected);
    }
  });

  it("preserves matrix rows, alignment, subscripts, and comparisons inside Markdown lists", async () => {
    const pipeline = createPipeline({ processors: "math" });
    pipeline.push(String.raw`- **Bound:** \(a_1 < b_2\).
- Matrix:

  \[
  \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
  \]
`);
    const frame = await run(() => pipeline.flush());
    const html = frame.blocks.map((block) => block.rendered).join("");
    expect(html).toContain("<strong>Bound:</strong>");
    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).not.toContain("katex-error");
  });

  it("preserves all four delimiters and LaTeX escapes through Markdown", async () => {
    const pipeline = createPipeline({ processors: "math" });
    pipeline.push(source);
    expect(pipeline.frame.blocks).toHaveLength(0);
    const frame = await run(() => pipeline.flush());
    const html = frame.blocks.map((block) => block.rendered).join("");
    const nodes = frame.blocks.flatMap((block) => getFrameDocument(block)?.math ?? []);
    expect(nodes.map((node) => node.delimiter)).toEqual(["$", "\\(", "$$", "\\["]);
    expect(nodes[2]?.latex).toContain(String.raw`x^2\,dx`);
    expect(html.match(/class="katex"/g)).toHaveLength(4);
    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(html).not.toContain("katex-error");
  });

  it("keeps incomplete math provisional and renders the same result across chunk boundaries", async () => {
    const streamed = createPipeline({ processors: "math" });
    streamed.push("Value\n" + String.raw`\[\frac{1}` + "\n");
    const provisional = await run(() => streamed.pull());
    const provisionalNode = getFrameDocument(provisional.blocks[0]!)?.math[0];
    expect(provisionalNode?.complete).toBe(false);
    expect(provisionalNode?.rendered).toBeUndefined();
    streamed.push(String.raw`{2}\]`);
    const completed = await run(() => streamed.flush());
    expect(getFrameDocument(completed.blocks[0]!)?.math[0]?.complete).toBe(true);
    expect(provisionalNode?.complete).toBe(false);

    const batched = createPipeline({ processors: "math" });
    batched.push("Value\n" + String.raw`\[\frac{1}` + "\n" + String.raw`{2}\]`);
    const single = await run(() => batched.flush());
    expect(completed.blocks[0]?.rendered).toBe(single.blocks[0]?.rendered);
  });

  it("reuses completed math nodes as prose arrives and does no work on push or an empty pull", async () => {
    const render = vi.spyOn(loader, "renderMathSync");
    try {
      const pipeline = createPipeline({ processors: "math" });
      pipeline.push("Start $x^2$\n");
      expect(render).not.toHaveBeenCalled();
      const first = await run(() => pipeline.pull());
      const node = getFrameDocument(first.blocks[0]!)?.math[0];
      expect(render).toHaveBeenCalledTimes(1);
      pipeline.push("more **prose**\n");
      const next = await run(() => pipeline.pull());
      expect(getFrameDocument(next.blocks[0]!)?.math[0]).toBe(node);
      expect(render).toHaveBeenCalledTimes(1);
      expect(next.blocks[0]?.rendered).toContain("<strong>prose</strong>");
      expect(await run(() => pipeline.pull())).toBe(next);
    } finally {
      render.mockRestore();
    }
  });

  it("leaves code, escaped currency, and link destinations out of math parsing", async () => {
    const pipeline = createPipeline({ processors: "math" });
    pipeline.push(
      String.raw`Inline code: \`$x$\`. Price: \$5. [link](https://example.com/$id$).

\`\`\`tex
$$x^2$$
\`\`\`
`.replace(/\\`/g, "`"),
    );
    const frame = await run(() => pipeline.flush());
    expect(frame.blocks.flatMap((block) => getFrameDocument(block)?.math ?? [])).toHaveLength(0);
    expect(frame.blocks.map((block) => block.rendered).join("")).not.toContain('class="katex"');
  });
});
