import { defineNodeRenderer } from "../node-renderer.ts";
import { mathSyntax } from "../math-syntax.ts";
import {
  renderMath,
  preloadKatex as preloadKatexLoader,
  isKatexReady as isKatexReadyLoader,
} from "../math/loader.ts";
import { registerBuiltinProcessor } from "../resolver.ts";

export const math = defineNodeRenderer({
  name: "math",
  syntax: mathSyntax,
  description: "Render LaTeX nodes with KaTeX",
  preload: preloadKatexLoader,
  isReady: isKatexReadyLoader,
  *render({ latex, displayMode }) {
    const result = yield* renderMath(latex, displayMode);
    if (!result.success) {
      return { status: "error", reason: result.error };
    }
    return `<span class="${displayMode ? "math-block" : "math-inline"}">${result.html}</span>`;
  },
});

registerBuiltinProcessor("math", () => math);
export const preloadMath = preloadKatexLoader;
export const isMathReady = isKatexReadyLoader;
