import type { NodeSyntax, SyntaxRule } from "./types.ts";

/** Declare pure inline and/or block syntax. Declarations contain no runtime state. */
export function defineNodeSyntax<T>(definition: NodeSyntax<T>): NodeSyntax<T> {
  if (!definition.name || (!definition.inline && !definition.block)) {
    throw new Error("Node syntax requires a name and an inline or block rule");
  }
  return Object.freeze({
    name: definition.name,
    ...(definition.inline && { inline: Object.freeze({ ...definition.inline }) }),
    ...(definition.block && { block: Object.freeze({ ...definition.block }) }),
  });
}

/**
 * Declare syntax within Markdown text; code and link destinations stay opaque.
 * Return null when no syntax starts here, or a nonempty source prefix and typed
 * data. Use complete: false to retain an unfinished node; it will not be rendered.
 * Matchers are pure. An optional start hint avoids scanning every text position.
 *
 * @example
 * const citationSyntax = defineInlineSyntax({
 *   name: "citation",
 *   match(source) {
 *     const match = /^\[@([a-zA-Z0-9_-]+)\]/.exec(source);
 *     return match
 *       ? { raw: match[0], data: { sourceId: match[1]! }, complete: true }
 *       : null;
 *   },
 * });
 */
export function defineInlineSyntax<T>(
  definition: SyntaxRule<T> & { readonly name: string },
): NodeSyntax<T> {
  return defineNodeSyntax({ name: definition.name, inline: definition });
}
