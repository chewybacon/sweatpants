import { run } from "effection";
import { expect, it } from "vitest";
import { createPipeline, defineFenceRenderer, shiki, type FenceContent } from "../index.ts";

it.each([false, true])(
  "routes custom fences ahead of Shiki in either order (%s), only on demand",
  async (first) => {
    const calls: FenceContent[] = [];
    const diagram = defineFenceRenderer({
      name: "diagram",
      languages: ["diagram-v2"],
      *render(content) {
        calls.push(content);
        return "<svg>diagram</svg>";
      },
    });
    const pipeline = createPipeline({ processors: first ? [diagram, shiki] : [shiki, diagram] });
    pipeline.push('```diagram-v2 title="Example" {1}\n<a> & b\n');
    expect(calls).toEqual([]);
    const open = await run(() => pipeline.pull());
    expect(open.blocks[0]?.rendered).toContain("&lt;a&gt; &amp; b");
    expect(open.blocks[0]?.rendered).not.toContain("quick-highlight");
    expect(calls).toEqual([]);
    pipeline.push("``");
    await run(() => pipeline.pull());
    expect(calls).toEqual([]);
    pipeline.push("`\n");
    expect(calls).toEqual([]);
    const closed = await run(() => pipeline.pull());
    expect(calls).toEqual([
      { code: "<a> & b\n", language: "diagram-v2", meta: 'title="Example" {1}' },
    ]);
    expect(closed.blocks[0]?.rendered).toBe("<svg>diagram</svg>");
    expect(open.blocks[0]?.rendered).toContain("&lt;a&gt;");
    expect(await run(() => pipeline.pull())).toBe(closed);
    pipeline.push("next paragraph\n");
    const next = await run(() => pipeline.flush());
    expect(next.blocks[0]).toBe(closed.blocks[0]);
    expect(calls).toHaveLength(1);
  },
);

it("keeps unclosed fences as source at end of stream", async () => {
  let calls = 0;
  const pipeline = createPipeline({
    processors: [
      defineFenceRenderer({
        name: "diagram",
        languages: ["diagram"],
        *render() {
          calls++;
          return "<svg/>";
        },
      }),
    ],
  });
  pipeline.push("~~~diagram\nunfinished <diagram>");
  const frame = await run(() => pipeline.flush());
  expect(calls).toBe(0);
  expect(frame.blocks[0]?.status).toBe("streaming");
  expect(frame.blocks[0]?.rendered).toContain("unfinished &lt;diagram&gt;");
});

it("caches previews while input is unchanged and isolates renderer routing between pipelines", async () => {
  let previews = 0;
  const fallback = defineFenceRenderer({
    name: "fallback",
    languages: "*",
    preview: ({ code }) => {
      previews++;
      return `preview:${code}`;
    },
    *render() {
      return "fallback";
    },
  });
  const custom = defineFenceRenderer({
    name: "custom",
    languages: ["x"],
    *render() {
      return "custom";
    },
  });
  const one = createPipeline({ processors: [fallback, custom] });
  const two = createPipeline({ processors: [fallback] });
  one.push("```x\nhi\n```\n");
  expect((await run(() => one.pull())).blocks[0]?.rendered).toBe("custom");
  two.push("```x\nhi\n");
  const open = await run(() => two.pull());
  two.push("partial");
  await run(() => two.pull());
  expect(previews).toBe(1);
  two.push("\n");
  const updated = await run(() => two.pull());
  expect(previews).toBe(2);
  expect(updated.blocks[0]?.rendered).toBe("preview:hi\npartial\n");
  expect(open.blocks[0]?.rendered).toBe("preview:hi\n");
  two.push("```\n");
  expect((await run(() => two.flush())).blocks[0]?.rendered).toBe("fallback");
});

it("records failed rendering once and retains source", async () => {
  let calls = 0;
  const pipeline = createPipeline({
    processors: [
      defineFenceRenderer({
        name: "broken",
        languages: ["x"],
        *render() {
          calls++;
          return { status: "error", reason: "Invalid diagram" };
        },
      }),
    ],
  });
  pipeline.push("```x\n<invalid>\n```\n");
  const frame = await run(() => pipeline.pull());
  expect(frame.blocks[0]?.rendered).toContain("&lt;invalid&gt;");
  expect(frame.blocks[0]?.fencePresentation?.error).toBe("Invalid diagram");
  expect(
    frame.trace.some((entry) => entry.action === "error" && entry.detail === "Invalid diagram"),
  ).toBe(true);
  pipeline.push("after\n");
  await run(() => pipeline.flush());
  expect(calls).toBe(1);
});

it("rejects ambiguous language ownership instead of depending on processor order", () => {
  const a = defineFenceRenderer({
    name: "a",
    languages: ["X"],
    *render() {
      return "a";
    },
  });
  const b = defineFenceRenderer({
    name: "b",
    languages: ["x"],
    *render() {
      return "b";
    },
  });
  expect(() => createPipeline({ processors: [a, b] })).toThrow("claimed by 'a' and 'b'");
});

it("retries unavailable renderers on later demand and exposes their reason", async () => {
  let ready = false;
  const pipeline = createPipeline({
    processors: [
      defineFenceRenderer({
        name: "browser-diagram",
        languages: ["x"],
        *render() {
          return ready ? "<svg/>" : { status: "unavailable", reason: "Browser required" };
        },
      }),
    ],
  });
  pipeline.push("```x\nsource\n```\n");
  const unavailable = await run(() => pipeline.pull());
  expect(unavailable.blocks[0]?.renderPass).toBe("quick");
  expect(
    unavailable.trace.some(
      (entry) => entry.action === "skip" && entry.detail === "Browser required",
    ),
  ).toBe(true);
  ready = true;
  pipeline.push("following text\n");
  const rendered = await run(() => pipeline.pull());
  expect(rendered.blocks[0]?.rendered).toBe("<svg/>");
});

it("passes fence metadata intact at every chunk boundary", async () => {
  const source = '```chart-v2 title="Flight path" {2}\nA --> B\n```';
  for (let split = 0; split <= source.length; split++) {
    const calls: FenceContent[] = [];
    const pipeline = createPipeline({
      processors: [
        defineFenceRenderer({
          name: "chart",
          languages: ["chart-v2"],
          *render(content) {
            calls.push(content);
            return "<svg/>";
          },
        }),
      ],
    });
    pipeline.push(source.slice(0, split));
    await run(() => pipeline.pull());
    pipeline.push(source.slice(split));
    await run(() => pipeline.flush());
    expect(calls).toEqual([
      { language: "chart-v2", code: "A --> B\n", meta: 'title="Flight path" {2}' },
    ]);
  }
});
