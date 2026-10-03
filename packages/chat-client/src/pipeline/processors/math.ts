/** Render preserved math nodes on demand, without matching LaTeX against generated HTML. */
import type { Operation } from "effection";
import type { Frame, Processor } from "../types.ts";
import { addTrace, updateBlockById } from "../frame.ts";
import { escapeText, getFrameDocument, renderFrameDocument } from "../document.ts";
import {
  renderMathSync,
  preloadKatex as preloadKatexLoader,
  isKatexReady as isKatexReadyLoader,
} from "../../math/loader.ts";
import { registerBuiltinProcessor } from "../resolver.ts";

export const math: Processor = {
  name: "math",
  description: "Render preserved LaTeX nodes with KaTeX",
  dependencies: ["markdown"],
  preload: preloadKatexLoader,
  isReady: isKatexReadyLoader,

  process: function* (frame: Frame): Operation<Frame> {
    let current = frame;
    for (const block of frame.blocks) {
      if (block.type !== "text") {
        continue;
      }
      const document = getFrameDocument(block);
      if (!document || document.mathRendered || document.math.length === 0) {
        continue;
      }
      const nodes = document.math.map((node) => {
        if (!node.complete || node.rendered !== undefined) {
          return node;
        }
        const html = renderMathSync(node.latex, node.displayMode);
        const className = node.displayMode ? "math-block" : "math-inline";
        return {
          ...node,
          rendered: `<span class="${className}${html === null ? " math-error" : ""}">${html ?? escapeText(node.raw)}</span>`,
        };
      });
      const renderedDocument = { ...document, math: nodes, mathRendered: true };
      current = updateBlockById(current, block.id, (prior) => ({
        ...prior,
        meta: { ...prior.meta, document: renderedDocument },
        rendered: renderFrameDocument(renderedDocument),
      }));
      current = addTrace(current, "math", "update", {
        blockId: block.id,
        detail: `rendered ${nodes.length} math node(s)`,
      });
    }
    return current;
  },
};

registerBuiltinProcessor("math", () => math);
export const preloadMath = preloadKatexLoader;
export const isMathReady = isKatexReadyLoader;
