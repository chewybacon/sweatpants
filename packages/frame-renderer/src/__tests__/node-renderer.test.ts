import { run } from "effection";
import { expect, expectTypeOf, it, vi } from "vitest";
import {
  createPipeline,
  defineInlineSyntax,
  defineNodeRenderer,
  getFrameNodes,
  math,
  mathSyntax,
  type NodeRenderResult,
} from "../index.ts";
import * as mathLoader from "../math/loader.ts";

const citationSyntax = defineInlineSyntax({
  name: "citation",
  match(source) {
    const match = /^\[@([a-zA-Z0-9_-]+)\]/.exec(source);
    return match ? { raw: match[0], data: { sourceId: match[1]! }, complete: true } : null;
  },
});

it("renders typed citations and math on demand, preserving completed nodes and prior frames", async () => {
  const calls: string[] = [];
  const renderMath = vi.spyOn(mathLoader, "renderMath");
  try {
    const citations = defineNodeRenderer({
      name: "citations",
      syntax: citationSyntax,
      *render(data) {
        expectTypeOf(data).toEqualTypeOf<{ sourceId: string }>();
        calls.push(data.sourceId);
        return `<a href="#${data.sourceId}">citation</a>`;
      },
    });
    const pipeline = createPipeline({ processors: [math, citations] });
    pipeline.push("The energy is $E = mc^2$ [@ein\n");
    expect(calls).toEqual([]);
    expect(renderMath).not.toHaveBeenCalled();
    const first = await run(() => pipeline.pull());
    const mathNode = getFrameNodes(first.blocks[0]!, mathSyntax)[0];
    expect(renderMath).toHaveBeenCalledTimes(1);
    expect(first.blocks[0]?.rendered).toContain("[@ein");
    expect(calls).toEqual([]);
    pipeline.push("Another reference [@einstein].\n");
    const second = await run(() => pipeline.pull());
    expect(calls).toEqual(["einstein"]);
    expect(second.blocks[0]?.rendered).toContain('<a href="#einstein">citation</a>');
    expect(getFrameNodes(second.blocks[0]!, mathSyntax)[0]).toBe(mathNode);
    expect(renderMath).toHaveBeenCalledTimes(1);
    expect(first.blocks[0]?.rendered).not.toContain('<a href="#einstein">');
    expect(await run(() => pipeline.pull())).toBe(second);
    pipeline.push("following prose\n");
    await run(() => pipeline.flush());
    expect(calls).toEqual(["einstein"]);
    expect(renderMath).toHaveBeenCalledTimes(1);
  } finally {
    renderMath.mockRestore();
  }
});

it("recognizes citations in prose, lists and tables while leaving code, escapes and destinations opaque", async () => {
  const calls: string[] = [];
  const citations = defineNodeRenderer({
    name: "citations",
    syntax: citationSyntax,
    *render({ sourceId }) {
      calls.push(sourceId);
      return `<sup>${sourceId}</sup>`;
    },
  });
  const pipeline = createPipeline({ processors: [citations] });
  pipeline.push(
    "Prose [@prose]. `[@code]` and \\[@escaped]. [link](https://example.com/[@destination]).\n\n- List [@list]\n\n| Reference |\n| --- |\n| [@table] |\n\n```text\n[@fenced]\n```\n",
  );
  const frame = await run(() => pipeline.flush());
  expect(calls).toEqual(["prose", "list", "table"]);
  const html = frame.blocks.map((block) => block.rendered).join("");
  expect(html).toContain("<code>[@code]</code>");
  expect(html).toContain("[@escaped]");
  expect(html).toContain("[@fenced]");
  expect(html).toContain("<td><sup>table</sup></td>");
});

it("produces the same citation at every transport split, and leaves an unfinished citation literal", async () => {
  const input = "Read [@einstein].";
  for (let split = 0; split <= input.length; split++) {
    let calls = 0;
    const pipeline = createPipeline({
      processors: [
        defineNodeRenderer({
          name: "citations",
          syntax: citationSyntax,
          *render({ sourceId }) {
            calls++;
            return `<sup>${sourceId}</sup>`;
          },
        }),
      ],
    });
    pipeline.push(input.slice(0, split));
    await run(() => pipeline.pull());
    expect(calls).toBe(0);
    pipeline.push(input.slice(split));
    expect((await run(() => pipeline.flush())).blocks[0]?.rendered).toContain(
      "Read <sup>einstein</sup>.",
    );
    expect(calls).toBe(1);
  }
  const pipeline = createPipeline({
    processors: [
      defineNodeRenderer({
        name: "citations",
        syntax: citationSyntax,
        *render() {
          throw new Error("Unfinished citation must not render");
        },
      }),
    ],
  });
  pipeline.push("Read [@unfinished");
  expect((await run(() => pipeline.flush())).blocks[0]?.rendered).toContain("Read [@unfinished");
});

it("allows isolated renderer configurations for the same shared syntax", async () => {
  const first = createPipeline({
    processors: [
      defineNodeRenderer({
        name: "citations",
        syntax: citationSyntax,
        *render({ sourceId }) {
          return `<sup>A:${sourceId}</sup>`;
        },
      }),
    ],
  });
  const second = createPipeline({
    processors: [
      defineNodeRenderer({
        name: "citations",
        syntax: citationSyntax,
        *render({ sourceId }) {
          return `<sup>B:${sourceId}</sup>`;
        },
      }),
    ],
  });
  first.push("[@ref]\n");
  second.push("[@ref]\n");
  expect((await run(() => first.pull())).blocks[0]?.rendered).toContain("A:ref");
  expect((await run(() => second.pull())).blocks[0]?.rendered).toContain("B:ref");
  const plain = createPipeline({ processors: "markdown" });
  plain.push("[@ref]\n");
  expect((await run(() => plain.flush())).blocks[0]?.rendered).toContain("[@ref]");
});

it("settles explicit errors with source and diagnostics while retrying unavailable nodes on later demand", async () => {
  let ready = false;
  const calls: string[] = [];
  const pipeline = createPipeline({
    processors: [
      defineNodeRenderer({
        name: "citations",
        syntax: citationSyntax,
        *render({ sourceId }): Generator<never, NodeRenderResult> {
          calls.push(sourceId);
          if (sourceId === "bad") {
            return { status: "error", reason: "Unknown source" };
          }
          return ready ? "<sup>loaded</sup>" : { status: "unavailable", reason: "Not loaded" };
        },
      }),
    ],
  });
  pipeline.push("[@bad] [@waiting]\n");
  const first = await run(() => pipeline.pull());
  expect(first.blocks[0]?.rendered).toContain("[@bad] [@waiting]");
  expect(
    first.trace.some((entry) => entry.action === "error" && entry.detail === "Unknown source"),
  ).toBe(true);
  expect(
    first.trace.some((entry) => entry.action === "skip" && entry.detail === "Not loaded"),
  ).toBe(true);
  ready = true;
  pipeline.push("more\n");
  const second = await run(() => pipeline.pull());
  expect(calls).toEqual(["bad", "waiting", "waiting"]);
  expect(second.blocks[0]?.rendered).toContain("[@bad] <sup>loaded</sup>");
});

it("uses a cheap incomplete preview and switches to full rendering only when the node completes", async () => {
  const previews: string[] = [];
  const renders: string[] = [];
  const customMath = defineNodeRenderer({
    name: "custom-math",
    syntax: mathSyntax,
    preview({ latex }) {
      previews.push(latex);
      return "<span>typing math</span>";
    },
    *render({ latex }) {
      renders.push(latex);
      return "<span>complete math</span>";
    },
  });
  const pipeline = createPipeline({ processors: [customMath] });
  pipeline.push("$$x\n");
  const open = await run(() => pipeline.pull());
  expect(open.blocks[0]?.rendered).toContain("typing math");
  expect(renders).toEqual([]);
  expect(previews).toHaveLength(1);
  pipeline.push("$$\n");
  const closed = await run(() => pipeline.flush());
  expect(renders).toEqual(["x\n"]);
  expect(previews).toHaveLength(1);
  expect(closed.blocks[0]?.rendered).toContain("complete math");
  expect(open.blocks[0]?.rendered).toContain("typing math");
});

it("rejects ambiguous syntax ownership and non-consuming matchers", async () => {
  const a = defineNodeRenderer({
    name: "a",
    syntax: citationSyntax,
    *render() {
      return "a";
    },
  });
  const b = defineNodeRenderer({
    name: "b",
    syntax: citationSyntax,
    *render() {
      return "b";
    },
  });
  expect(() => createPipeline({ processors: [a, b] })).toThrow("claimed by 'a' and 'b'");
  const invalid = defineInlineSyntax({
    name: "invalid",
    match: () => ({ raw: "", data: {}, complete: true }),
  });
  const pipeline = createPipeline({
    processors: [
      defineNodeRenderer({
        name: "invalid",
        syntax: invalid,
        *render() {
          return "";
        },
      }),
    ],
  });
  pipeline.push("text\n");
  await expect(run(() => pipeline.pull())).rejects.toThrow("nonempty source prefix");
});
