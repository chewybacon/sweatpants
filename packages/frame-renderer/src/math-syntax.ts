import type { SyntaxMatch } from "./types.ts";
import { defineNodeSyntax } from "./syntax.ts";

export interface MathContent {
  readonly latex: string;
  readonly delimiter: "$" | "$$" | "\\(" | "\\[";
  readonly displayMode: boolean;
}

function matchMath(source: string, displayOnly: boolean): SyntaxMatch<MathContent> | null {
  const delimiter = (["$$", "\\[", "\\(", "$"] as const).find((open) => source.startsWith(open));
  if (!delimiter) {
    return null;
  }
  const displayMode = delimiter === "$$" || delimiter === "\\[";
  if (displayOnly && !displayMode) {
    return null;
  }
  // A dollar followed by whitespace is prose/currency, not an opening delimiter.
  if (delimiter === "$" && (!source[1] || /\s/.test(source[1]))) {
    return null;
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
    raw: source.slice(0, rawEnd),
    data: { latex: source.slice(delimiter.length, latexEnd), delimiter, displayMode },
    complete,
  };
}

/** Inline and display math share recognition while respecting Markdown nesting. */
export const mathSyntax = defineNodeSyntax<MathContent>({
  name: "math",
  inline: {
    start: (source) => source.search(/\$|\\[([]/),
    match: (source) => matchMath(source, false),
  },
  block: {
    start: (source) => source.search(/^(?:\$\$|\\\[)/m),
    match: (source) => matchMath(source, true),
  },
});
