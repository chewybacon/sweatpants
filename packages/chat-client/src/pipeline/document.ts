import { Marked, type TokensList } from "marked";
import type { Block } from "./types.ts";

/** Semantic math source retained inside a frame, before Markdown consumes escapes. */
export interface MathNode {
  readonly type: "math";
  readonly id: string;
  readonly raw: string;
  readonly latex: string;
  readonly delimiter: "$" | "$$" | "\\(" | "\\[";
  readonly displayMode: boolean;
  readonly complete: boolean;
  readonly rendered?: string;
}

/** Processor-owned document in Block.meta; tokens retain Markdown nesting and math references. */
export interface FrameDocument {
  readonly source: string;
  readonly tokens: TokensList;
  readonly math: readonly MathNode[];
  readonly mathRendered: boolean;
}

interface MathToken extends TokenFields {
  type: "frameMath";
  node: number;
}
interface TokenFields {
  raw: string;
  latex: string;
  delimiter: MathNode["delimiter"];
  displayMode: boolean;
  complete: boolean;
}

export function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Called by Markdown's lexer, so code spans/fences and link destinations stay opaque. */
function mathToken(source: string, displayOnly: boolean): MathToken | undefined {
  const delimiter = (["$$", "\\[", "\\(", "$"] as const).find((open) => source.startsWith(open));
  if (!delimiter) {
    return;
  }
  const displayMode = delimiter === "$$" || delimiter === "\\[";
  if (displayOnly && !displayMode) {
    return;
  }
  // A dollar followed by whitespace is prose/currency, not an opening delimiter.
  if (delimiter === "$" && (!source[1] || /\s/.test(source[1]))) {
    return;
  }
  const close = delimiter === "\\[" ? "\\]" : delimiter === "\\(" ? "\\)" : delimiter;
  let end = delimiter.length;
  let complete = false;
  for (; end < source.length; end++) {
    if (!displayMode && source[end] === "\n") {
      break;
    }
    if (source.startsWith(close, end)) {
      complete = true;
      break;
    }
    // Escaped punctuation cannot close a dollar expression.
    if (source[end] === "\\" && delimiter.startsWith("$")) {
      end++;
    }
  }
  const latexEnd = Math.min(end, source.length);
  const rawEnd = complete ? end + close.length : latexEnd;
  return {
    type: "frameMath",
    node: -1,
    raw: source.slice(0, rawEnd),
    latex: source.slice(delimiter.length, latexEnd),
    delimiter,
    displayMode,
    complete,
  };
}

function parser(render: (token: MathToken) => string): Marked {
  return new Marked({
    extensions: [
      {
        name: "frameMath",
        level: "block",
        // A block boundary is a line boundary, never a delimiter inside a code span.
        start: (source) => source.search(/^(?:\$\$|\\\[)/m),
        tokenizer: (source) => mathToken(source, true),
        renderer: (token) => render(token as MathToken),
      },
      {
        name: "frameMath",
        level: "inline",
        start: (source) => source.search(/\$|\\[([]/),
        tokenizer: (source) => mathToken(source, false),
        renderer: (token) => render(token as MathToken),
      },
    ],
  });
}

export function getFrameDocument(block: Block): FrameDocument | undefined {
  return block.meta?.["document"] as FrameDocument | undefined;
}

/** Only called on a presentation pull. Previous snapshots and completed math nodes stay immutable. */
export function parseFrameDocument(block: Block): FrameDocument {
  const previous = getFrameDocument(block);
  if (previous?.source === block.raw) {
    return previous;
  }
  const engine = parser((token) => escapeText(token.raw));
  const tokens = engine.lexer(block.raw);
  const math: MathNode[] = [];
  engine.walkTokens(tokens, (token) => {
    if (token.type !== "frameMath") {
      return;
    }
    const parsed = token as MathToken;
    parsed.node = math.length;
    const prior = previous?.math[math.length];
    math.push(
      prior?.raw === parsed.raw
        ? prior
        : {
            type: "math",
            id: `${block.id}:math:${math.length}`,
            raw: parsed.raw,
            latex: parsed.latex,
            delimiter: parsed.delimiter,
            displayMode: parsed.displayMode,
            complete: parsed.complete,
          },
    );
  });
  return { source: block.raw, tokens, math, mathRendered: false };
}

/** Both processors render the same document; neither searches or patches another processor's HTML. */
export function renderFrameDocument(document: FrameDocument): string {
  return parser((token) => {
    const node = document.math[token.node]!;
    return node.rendered ?? escapeText(token.raw);
  }).parser(document.tokens);
}
