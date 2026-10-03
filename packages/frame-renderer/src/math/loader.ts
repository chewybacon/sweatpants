import { call, type Operation } from "effection";
import type * as KatexModule from "katex";
type Katex = typeof KatexModule;
let katex: Katex | undefined;
let loading: Promise<Katex> | undefined;

/** Shared on-demand import; failed loads can be retried by a later render. */
function initKatex(): Promise<Katex> {
  loading ??= import("katex").then(
    (module) => {
      katex = module;
      return module;
    },
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

export function isKatexReady(): boolean {
  return katex !== undefined;
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
