/** Shiki and its grammars load only when a completed code fence needs them. */
import { call, type Operation } from "effection";
import type * as ShikiModule from "shiki";

const THEME = "github-dark";
let library: Promise<typeof ShikiModule> | undefined;
let loading: Promise<ShikiModule.Highlighter> | undefined;
let highlighter: ShikiModule.Highlighter | undefined;
const languageLoads = new Map<string, Promise<void>>();

function getLibrary(): Promise<typeof ShikiModule> {
  library ??= import("shiki").catch((error: unknown) => {
    library = undefined;
    throw error;
  });
  return library;
}

function getHighlighter(): Promise<ShikiModule.Highlighter> {
  loading ??= getLibrary()
    .then((module) =>
      module.createHighlighter({
        themes: [THEME],
        langs: [],
      }),
    )
    .then((instance) => {
      highlighter = instance;
      return instance;
    })
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

async function ensureLanguage(instance: ShikiModule.Highlighter, language: string): Promise<void> {
  if (instance.getLoadedLanguages().includes(language)) {
    return;
  }
  let pending = languageLoads.get(language);
  if (!pending) {
    pending = instance.loadLanguage(language as ShikiModule.BundledLanguage).finally(() => {
      languageLoads.delete(language);
    });
    languageLoads.set(language, pending);
  }
  await pending;
}

function normalizeLanguage(lang: string): string {
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    rb: "ruby",
    yml: "yaml",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    console: "bash",
    terminal: "bash",
    plaintext: "text",
    plain: "text",
    txt: "text",
  };
  return aliases[lang.toLowerCase()] || lang.toLowerCase();
}

function plaintext(code: string): string {
  const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre class="code-block"><code>${escaped}</code></pre>`;
}

export function* highlightCode(code: string, language: string): Operation<string> {
  const normalized = normalizeLanguage(language);
  if (!normalized || normalized === "text") {
    return plaintext(code);
  }
  const module = yield* call(getLibrary);
  if (!Object.hasOwn(module.bundledLanguages, normalized)) {
    return plaintext(code);
  }
  const instance = yield* call(async () => {
    const ready = await getHighlighter();
    await ensureLanguage(ready, normalized);
    return ready;
  });
  return instance.codeToHtml(code, { lang: normalized, theme: THEME });
}

export function isHighlighterReady(): boolean {
  return highlighter !== undefined;
}

/** Explicit opt-in warmup of the engine and theme. Grammars remain demand-loaded. */
export async function preloadHighlighter(): Promise<void> {
  await getHighlighter();
}

export function getLoadedLanguages(): string[] {
  return highlighter?.getLoadedLanguages() ?? [];
}
