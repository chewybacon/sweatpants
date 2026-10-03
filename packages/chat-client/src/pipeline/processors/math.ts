import { defineNodeRenderer } from "../node-renderer.ts";
import { mathSyntax } from "../math-syntax.ts";
import {
  renderMathSync,
  preloadKatex as preloadKatexLoader,
  isKatexReady as isKatexReadyLoader,
} from "../../math/loader.ts";
import { registerBuiltinProcessor } from "../resolver.ts";

export const math = defineNodeRenderer({
  name: "math",
  syntax: mathSyntax,
  description: "Render LaTeX nodes with KaTeX",
  preload: preloadKatexLoader,
  isReady: isKatexReadyLoader,
  *render({ latex, displayMode }) {
    const html = renderMathSync(latex, displayMode);
    if (html === null) {
      return { status: "error", reason: "KaTeX could not render expression" };
    }
    return `<span class="${displayMode ? "math-block" : "math-inline"}">${html}</span>`;
  },
});

registerBuiltinProcessor("math", () => math);
export const preloadMath = preloadKatexLoader;
export const isMathReady = isKatexReadyLoader;
