import { Marked, type TokensList, type TokenizerAndRendererExtension } from "marked";
import type { Block, NodeSyntax, SyntaxRule } from "./types.ts";

/** Framework-owned immutable node snapshot. Application renderers receive only data. */
export interface RenderNode<T = unknown> {
  readonly id: string;
  readonly syntax: NodeSyntax<T>;
  readonly raw: string;
  readonly data: T;
  readonly complete: boolean;
  readonly rendered?: string;
  readonly settled?: boolean;
  readonly error?: string;
}

/** Internal Markdown document; parser-specific tokens never reach renderer callbacks. */
export interface FrameDocument {
  readonly source: string;
  readonly tokens: TokensList;
  readonly syntaxes: readonly NodeSyntax<unknown>[];
  readonly nodes: readonly RenderNode[];
}

interface NodeToken {
  type: string;
  raw: string;
  data: unknown;
  complete: boolean;
  node: number;
}

export function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findStart(source: string, rule: SyntaxRule<unknown>, level: "inline" | "block"): number {
  if (rule.start) {
    return rule.start(source);
  }
  // Matchers without a hint still work in the middle of prose. Block rules only
  // probe line boundaries so code spans cannot become false block boundaries.
  for (let index = 0; index < source.length; index++) {
    if (level === "block" && index > 0 && source[index - 1] !== "\n") {
      continue;
    }
    if (rule.match(source.slice(index))) {
      return index;
    }
  }
  return -1;
}

function parser(
  syntaxes: readonly NodeSyntax<unknown>[],
  render: (token: NodeToken) => string,
): Marked {
  const extensions: TokenizerAndRendererExtension[] = [];
  for (const [index, syntax] of syntaxes.entries()) {
    for (const level of ["block", "inline"] as const) {
      const rule = syntax[level];
      if (!rule) {
        continue;
      }
      const name = `frameNode${index}`;
      extensions.push({
        name,
        level,
        start: (source) => findStart(source, rule, level),
        tokenizer(source) {
          const match = rule.match(source);
          if (!match) {
            return undefined;
          }
          if (!match.raw || !source.startsWith(match.raw)) {
            throw new Error(`Syntax '${syntax.name}' must consume a nonempty source prefix`);
          }
          return { type: name, ...match, node: -1 };
        },
        renderer: (token) => render(token as NodeToken),
      });
    }
  }
  // Marked tries extensions in reverse registration order. Preserve the author's
  // processor order as the explicit precedence for overlapping syntax rules.
  // ES2022 target; this array is newly allocated and private to this parser.
  // oxlint-disable-next-line unicorn/no-array-reverse
  return new Marked({ extensions: extensions.reverse() });
}

export function getFrameDocument(block: Block): FrameDocument | undefined {
  return block.meta?.["document"] as FrameDocument | undefined;
}

/** Inspect nodes with their inferred data type, without exposing Markdown tokens. */
export function getFrameNodes<T>(block: Block, syntax: NodeSyntax<T>): readonly RenderNode<T>[] {
  return (getFrameDocument(block)?.nodes.filter((node) => node.syntax === syntax) ??
    []) as RenderNode<T>[];
}

/** Runs only on presentation demand. Unchanged nodes preserve their cached output. */
export function parseFrameDocument(
  block: Block,
  syntaxes: readonly NodeSyntax<unknown>[],
): FrameDocument {
  const previous = getFrameDocument(block);
  const sameSyntax =
    previous?.syntaxes.length === syntaxes.length &&
    previous.syntaxes.every((syntax, index) => syntax === syntaxes[index]);
  if (sameSyntax && previous.source === block.raw) {
    return previous;
  }
  const engine = parser(syntaxes, (token) => escapeText(token.raw));
  const tokens = engine.lexer(block.raw);
  const nodes: RenderNode[] = [];
  const counts = new Map<string, number>();
  const priorNodes = new Map(sameSyntax ? previous.nodes.map((node) => [node.id, node]) : []);
  const tokenSyntaxes = new Map(syntaxes.map((syntax, index) => [`frameNode${index}`, syntax]));
  engine.walkTokens(tokens, (token) => {
    const syntax = tokenSyntaxes.get(token.type);
    if (!syntax) {
      return;
    }
    const parsed = token as NodeToken;
    const ordinal = counts.get(syntax.name) ?? 0;
    counts.set(syntax.name, ordinal + 1);
    const id = `${block.id}:node:${syntax.name}:${ordinal}`;
    parsed.node = nodes.length;
    const prior = priorNodes.get(id);
    nodes.push(
      prior?.raw === parsed.raw && prior.complete === parsed.complete
        ? prior
        : { id, syntax, raw: parsed.raw, data: parsed.data, complete: parsed.complete },
    );
  });
  return { source: block.raw, tokens, syntaxes, nodes };
}

export function renderFrameDocument(document: FrameDocument): string {
  return parser(
    document.syntaxes,
    (token) => document.nodes[token.node]?.rendered ?? escapeText(token.raw),
  ).parser(document.tokens);
}
