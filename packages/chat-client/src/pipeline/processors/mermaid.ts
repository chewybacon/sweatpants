/**
 * pipeline/processors/mermaid.ts
 *
 * Mermaid diagram rendering processor.
 *
 * This processor:
 * - Quick pass: Syntax highlighting for mermaid code while streaming
 * - Full pass: Rendered SVG diagram when code block completes
 *
 * Only processes code blocks with language="mermaid".
 */
import { defineFenceRenderer } from "../fence-renderer.ts";
import {
  renderMermaid,
  preloadMermaid as preloadMermaidLoader,
  isMermaidReady as isMermaidReadyLoader,
} from "../../mermaid/loader.ts";
import { registerBuiltinProcessor } from "../resolver.ts";

// =============================================================================
// Quick Highlighting (Regex-based)
// =============================================================================

/**
 * Mermaid-specific syntax highlighting patterns.
 */
const MERMAID_PATTERNS: Array<{ pattern: RegExp; className: string }> = [
  // Diagram type keywords
  {
    pattern:
      /\b(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|xychart|block-beta)\b/g,
    className: "keyword",
  },
  // Direction keywords
  { pattern: /\b(TD|TB|BT|RL|LR)\b/g, className: "keyword" },
  // Arrows and connections
  { pattern: /(-->|--o|--x|<-->|---|\.\.\.>|===|==>|-.->|-\.-)/g, className: "operator" },
  // Subgraph
  { pattern: /\b(subgraph|end)\b/g, className: "keyword" },
  // Participants, actors
  {
    pattern:
      /\b(participant|actor|activate|deactivate|Note|note|over|loop|alt|else|opt|par|and|rect|critical|break)\b/g,
    className: "keyword",
  },
  // Styling
  { pattern: /\b(style|classDef|class|linkStyle)\b/g, className: "keyword" },
  // Comments
  { pattern: /(%%.*$)/gm, className: "comment" },
  // Labels in pipes
  { pattern: /(\|[^|]*\|)/g, className: "string" },
  // Node shapes
  { pattern: /(\[.*?\])/g, className: "string" },
  { pattern: /(\(.*?\))/g, className: "string" },
  { pattern: /(\{.*?\})/g, className: "string" },
];

/**
 * Apply quick regex-based highlighting to mermaid code.
 */
function quickHighlightMermaid(code: string): string {
  // Start with HTML escaping
  const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Build combined regex
  const combinedParts: string[] = [];
  const patternInfo: Array<{ className: string; groupIndex: number }> = [];
  let groupCount = 0;

  for (const { pattern, className } of MERMAID_PATTERNS) {
    combinedParts.push(pattern.source);
    patternInfo.push({ className, groupIndex: groupCount + 1 });
    const groupsInPattern = (pattern.source.match(/\((?!\?)/g) || []).length;
    groupCount += groupsInPattern;
  }

  const combinedRegex = new RegExp(combinedParts.join("|"), "gm");

  return escaped.replace(combinedRegex, (...args) => {
    const fullMatch = args[0];
    const captureGroups = args.slice(1, -2);

    for (const { className, groupIndex } of patternInfo) {
      const captured = captureGroups[groupIndex - 1];
      if (captured !== undefined) {
        return `<span class="ql-${className}">${captured}</span>`;
      }
    }

    return fullMatch;
  });
}

/**
 * Wrap highlighted mermaid code in a pre/code block.
 */
function wrapCodeBlock(html: string, isQuick: boolean): string {
  const passClass = isQuick ? " quick-highlight" : " mermaid-rendered";
  return `<pre class="code-block mermaid-code${passClass}"><code class="language-mermaid">${html}</code></pre>`;
}

// =============================================================================
// Mermaid Processor
// =============================================================================

/**
 * Mermaid diagram rendering processor.
 *
 * Renders mermaid code blocks as SVG diagrams:
 * 1. Quick pass: Applies mermaid syntax highlighting while streaming
 * 2. Full pass: Renders the diagram as SVG when code block completes
 *
 * Only processes code blocks with language="mermaid".
 *
 * @example
 * ```typescript
 * import { mermaid } from '@sweatpants/chat-client/pipeline'
 *
 * useChat({
 *   processors: [mermaid]  // markdown will be auto-added as dependency
 * })
 * ```
 */
export const mermaid = defineFenceRenderer({
  name: "mermaid",
  description: "Render Mermaid diagrams",
  languages: ["mermaid"],
  *preload() {
    yield* preloadMermaidLoader();
  },
  isReady: isMermaidReadyLoader,
  preview: ({ code }) => wrapCodeBlock(quickHighlightMermaid(code), true),
  *render({ code }) {
    const result = yield* renderMermaid(code);
    if (result.success) {
      return result.svg;
    }
    return {
      status: result.error === "Mermaid requires browser environment" ? "unavailable" : "error",
      reason: result.error,
    };
  },
});

// Register as built-in for auto-dependency resolution
registerBuiltinProcessor("mermaid", () => mermaid);

// =============================================================================
// Preload Helper (for external use)
// =============================================================================

/**
 * Preload Mermaid library.
 * Call this early to avoid delay when first mermaid block completes.
 */
export const preloadMermaid = preloadMermaidLoader;

/**
 * Check if Mermaid is ready.
 */
export const isMermaidReady = isMermaidReadyLoader;
