# @sweatpants/frame-renderer

Demand-driven streaming document rendering, independent of chat, transport, and UI frameworks. Uses Effection operations for asynchronous rendering.

```ts
import { run } from "effection";
import { createPipeline, markdown, math, shiki, mermaid } from "@sweatpants/frame-renderer";

const pipeline = createPipeline({ processors: [markdown, math, shiki, mermaid] });

pipeline.push("Hello **world**.\n"); // Buffer incoming chunks; no rendering yet.
const frame = await run(() => pipeline.pull()); // Render at the consumer's cadence.
const html = frame.blocks.map((block) => block.rendered).join("");

pipeline.push("The answer is $x^2$.");
const finalFrame = await run(() => pipeline.flush()); // Settle the remaining text.
```

Use one pipeline per independent content stream. `push` buffers text synchronously; `pull` processes accumulated input and returns a frame snapshot. An empty pull returns the same frame. The parser buffers incomplete lines until a newline or `flush`. The consumer owns scheduling and publication; this package does not create an animation loop or a transport subscription. Call `reset()` to reuse a pipeline for a new document.

Built-in presets are `"markdown"`, `"math"`, `"shiki"`, `"mermaid"`, and `"full"`. KaTeX, Shiki, and Mermaid load only when eligible content needs them. Shiki loads requested grammars on demand. Unfinished fences remain source previews; closed fences render when pulled. Mermaid requires a browser. Math inside code remains literal. Browser hosts must include KaTeX's stylesheet and fonts to display math correctly (for example, `import "katex/dist/katex.min.css"` when KaTeX is a direct dependency of the host).

## Authoring renderers

A fence renderer receives code, language, and fence metadata. The pipeline handles routing, source previews, caching, and diagnostics. A renderer claiming a language takes precedence over Shiki's generic fallback regardless of processor order.

```ts
import { createPipeline, defineFenceRenderer, markdown, shiki } from "@sweatpants/frame-renderer";

const diagram = defineFenceRenderer({
    name: "diagram",
    languages: ["diagram"],
    *render({ code, meta }) {
        return yield* renderDiagram(code, meta); // Your Effection operation returning HTML.
    },
});

const pipeline = createPipeline({ processors: [markdown, shiki, diagram] });
```

For inline or block syntax, pair `defineInlineSyntax` or `defineNodeSyntax` with `defineNodeRenderer`. Matchers return a source prefix, typed data, and whether the syntax is complete; renderers receive that data. These extensions respect Markdown code and escaping rules. `getFrameNodes(block, syntax)` exposes typed nodes without exposing the Markdown parser's tokens.

Renderer callbacks return trusted HTML: escape untrusted values you interpolate. Typed error results preserve source and record frame diagnostics; thrown errors propagate to the consumer. Optional `preload` and `isReady` hooks support explicit warming through `preloadProcessors`; constructing a pipeline does not preload heavy engines.

Chat-specific compaction, message state, and client scheduling live in `@sweatpants/chat-client` and `@sweatpants/react-chat`.
