import { call, type Operation } from "effection";
import * as katex from "katex";

const katexInstance: typeof katex = katex;

/** KaTeX is statically linked so the headless pipeline has one deterministic module graph. */
async function initKatex(): Promise<typeof katex> {
  return katexInstance;
}

export function isKatexReady(): boolean {
  return true;
}

export function preloadKatex(): Operation<void> {
  return call(async () => {
    await initKatex();
  });
}

export type MathRenderResult = { success: true; html: string } | { success: false; error: string };

export function renderMath(latex: string, displayMode: boolean): Operation<MathRenderResult> {
  return call(async () => {
    try {
      const module = await initKatex();
      const html = module.renderToString(latex, {
        displayMode,
        throwOnError: false,
        errorColor: "#ef4444",
        trust: false,
        strict: "warn",
        output: "html",
      });
      return { success: true, html } as const;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      } as const;
    }
  });
}

export function renderMathSync(latex: string, displayMode: boolean): string | null {
  try {
    return katexInstance.renderToString(latex, {
      displayMode,
      throwOnError: false,
      errorColor: "#ef4444",
      trust: false,
      strict: "warn",
      output: "html",
    });
  } catch {
    return null;
  }
}
