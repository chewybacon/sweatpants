import { run } from "effection";
import { afterEach, expect, it, vi } from "vitest";

// Each test gets a cold module graph. Mock factories observe actual import timing,
// not readiness flags that could conceal an eager vendor import.
afterEach(() => {
  vi.doUnmock("katex");
  vi.doUnmock("shiki");
  vi.doUnmock("mermaid");
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("does not import heavy engines for full-pipeline startup, prose or open fences", async () => {
  vi.resetModules();
  const katex = vi.fn(() => ({}));
  const shiki = vi.fn(() => ({}));
  const mermaid = vi.fn(() => ({}));
  vi.doMock("katex", katex);
  vi.doMock("shiki", shiki);
  vi.doMock("mermaid", mermaid);
  const { createPipeline } = await import("../index.ts");
  for (const content of [
    "Just **prose**.\n",
    "```typescript\nlet value = 1;\n",
    "```mermaid\ngraph TD\n",
    "$$x\n",
  ]) {
    const pipeline = createPipeline({ processors: "full" });
    pipeline.push(content);
    await run(() => pipeline.flush());
  }
  expect(katex).not.toHaveBeenCalled();
  expect(shiki).not.toHaveBeenCalled();
  expect(mermaid).not.toHaveBeenCalled();
});

it("shares one KaTeX import across concurrent pulls and still supports explicit preloading", async () => {
  vi.resetModules();
  const render = vi.fn(() => '<span class="katex">math</span>');
  const imported = vi.fn(() => ({ renderToString: render }));
  vi.doMock("katex", imported);
  const { createPipeline, preloadMath, isMathReady } = await import("../index.ts");
  const one = createPipeline({ processors: "math" });
  const two = createPipeline({ processors: "math" });
  one.push("$x$\n");
  two.push("$y$\n");
  expect(imported).not.toHaveBeenCalled();
  expect(isMathReady()).toBe(false);
  await Promise.all([run(() => one.pull()), run(() => two.pull())]);
  expect(imported).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledTimes(2);
  expect(isMathReady()).toBe(true);
  await run(() => preloadMath());
  expect(imported).toHaveBeenCalledTimes(1);
});

it("loads only requested Shiki grammars and coalesces concurrent language loads", async () => {
  vi.resetModules();
  const languages: string[] = [];
  const loadLanguage = vi.fn(async (language: string) => {
    languages.push(language);
  });
  const createHighlighter = vi.fn(async () => ({
    getLoadedLanguages: () => languages,
    loadLanguage,
    codeToHtml: () => '<pre class="shiki">highlighted</pre>',
  }));
  const imported = vi.fn(() => ({
    createHighlighter,
    bundledLanguages: { typescript: {}, python: {} },
  }));
  vi.doMock("shiki", imported);
  const { highlightCode } = await import("../shiki/loader.ts");
  expect(await run(() => highlightCode("<plain>", "text"))).toContain("&lt;plain&gt;");
  expect(imported).not.toHaveBeenCalled();
  await Promise.all([
    run(() => highlightCode("const a = 1", "ts")),
    run(() => highlightCode("const b = 2", "typescript")),
  ]);
  expect(imported).toHaveBeenCalledTimes(1);
  expect(createHighlighter).toHaveBeenCalledExactlyOnceWith({ themes: ["github-dark"], langs: [] });
  expect(loadLanguage).toHaveBeenCalledExactlyOnceWith("typescript");
  expect(languages).toEqual(["typescript"]);
  await run(() => highlightCode("print(1)", "py"));
  expect(languages).toEqual(["typescript", "python"]);
  expect(await run(() => highlightCode("<unknown>", "nonexistent-language"))).toContain(
    "&lt;unknown&gt;",
  );
  expect(loadLanguage).toHaveBeenCalledTimes(2);
});

it("does not import Mermaid on the server", async () => {
  vi.resetModules();
  const imported = vi.fn(() => ({}));
  vi.doMock("mermaid", imported);
  const { renderMermaid, preloadMermaid } = await import("../mermaid/loader.ts");
  await run(() => preloadMermaid());
  expect(await run(() => renderMermaid("graph TD\nA-->B"))).toEqual({
    success: false,
    error: "Mermaid requires browser environment",
  });
  expect(imported).not.toHaveBeenCalled();
});

it("imports and initializes Mermaid once when a browser first needs a diagram", async () => {
  vi.resetModules();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  const initialize = vi.fn();
  const imported = vi.fn(() => ({
    default: {
      initialize,
      parse: async () => true,
      render: async () => ({ svg: "<svg/>" }),
    },
  }));
  vi.doMock("mermaid", imported);
  const { renderMermaid, isMermaidReady } = await import("../mermaid/loader.ts");
  expect(isMermaidReady()).toBe(false);
  expect(imported).not.toHaveBeenCalled();
  const results = await Promise.all([
    run(() => renderMermaid("graph TD\nA-->B")),
    run(() => renderMermaid("graph TD\nB-->C")),
  ]);
  expect(results.every((result) => result.success)).toBe(true);
  expect(imported).toHaveBeenCalledTimes(1);
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(isMermaidReady()).toBe(true);
});

it("surfaces lazy math failures through the frame diagnostics", async () => {
  vi.resetModules();
  vi.doMock("katex", () => ({
    renderToString() {
      throw new Error("Renderer unavailable");
    },
  }));
  const { createPipeline } = await import("../index.ts");
  const pipeline = createPipeline({ processors: "math" });
  pipeline.push("$x$\n");
  const frame = await run(() => pipeline.pull());
  expect(frame.blocks[0]?.rendered).toContain("$x$");
  expect(
    frame.trace.some(
      (entry) => entry.action === "error" && entry.detail === "Renderer unavailable",
    ),
  ).toBe(true);
});

it("allows a later Shiki request to retry failed initialization", async () => {
  vi.resetModules();
  const createHighlighter = vi
    .fn()
    .mockRejectedValueOnce(new Error("Engine initialization failed"))
    .mockResolvedValue({
      getLoadedLanguages: () => ["typescript"],
      codeToHtml: () => '<pre class="shiki">recovered</pre>',
    });
  vi.doMock("shiki", () => ({ createHighlighter, bundledLanguages: { typescript: {} } }));
  const { highlightCode } = await import("../shiki/loader.ts");
  await expect(run(() => highlightCode("const x = 1", "ts"))).rejects.toThrow(
    "Engine initialization failed",
  );
  expect(await run(() => highlightCode("const x = 1", "ts"))).toContain("recovered");
  expect(createHighlighter).toHaveBeenCalledTimes(2);
});
