/**
 * shiki/loader.ts
 * 
 * Singleton Shiki highlighter with hybrid language loading.
 * 
 * Strategy:
 * - Pre-load common languages (JS/TS/Python/JSON/Bash/CSS/HTML) on first use
 * - Lazy-load exotic languages on demand
 * - Returns an Effection Operation for async integration
 * 
 * Usage:
 * ```typescript
 * const html = yield* highlightCode(code, 'python')
 * ```
 */
import { call } from 'effection'
import type { Operation } from 'effection'
import {
  createHighlighter,
  type Highlighter,
  type BundledLanguage,
  type BundledTheme,
} from 'shiki'

// Common languages to preload (covers most LLM output)
const PRELOAD_LANGUAGES: BundledLanguage[] = [
  'javascript',
  'typescript',
  'python',
  'json',
  'bash',
  'css',
  'html',
  'markdown',
  'tsx',
  'jsx',
]

// Theme to use (dark theme for our slate UI)
const THEME: BundledTheme = 'github-dark'

// Singleton state
let highlighterPromise: Promise<Highlighter> | null = null
let highlighter: Highlighter | null = null
const loadedLanguages = new Set<string>()

/**
 * Get the Shiki highlighter, initializing if needed.
 * First call triggers preloading of common languages.
 */
async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter

  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEME],
      langs: PRELOAD_LANGUAGES,
    }).then((h) => {
      highlighter = h
      PRELOAD_LANGUAGES.forEach((lang) => loadedLanguages.add(lang))
      return h
    })
  }

  return highlighterPromise
}

/**
 * Ensure a language is loaded, lazy-loading if necessary.
 */
async function ensureLanguage(lang: string): Promise<boolean> {
  const h = await getHighlighter()

  // Already loaded
  if (loadedLanguages.has(lang)) return true

  // Check if it's a valid bundled language
  const loadedLangs = h.getLoadedLanguages()
  if (loadedLangs.includes(lang)) {
    loadedLanguages.add(lang)
    return true
  }

  // Try to load it
  try {
    await h.loadLanguage(lang as BundledLanguage)
    loadedLanguages.add(lang)
    return true
  } catch (e) {
    console.warn(`Shiki: Failed to load language "${lang}":`, e)
    return false
  }
}

/**
 * Map common language aliases to Shiki language IDs.
 */
function normalizeLanguage(lang: string): string {
  const aliases: Record<string, string> = {
    'js': 'javascript',
    'ts': 'typescript',
    'py': 'python',
    'rb': 'ruby',
    'yml': 'yaml',
    'sh': 'bash',
    'shell': 'bash',
    'zsh': 'bash',
    'console': 'bash',
    'terminal': 'bash',
    'plaintext': 'text',
    'plain': 'text',
    'txt': 'text',
  }
  return aliases[lang.toLowerCase()] || lang.toLowerCase()
}

/**
 * Highlight code using Shiki.
 * 
 * This is an Effection Operation that:
 * 1. Ensures the highlighter is loaded
 * 2. Lazy-loads the language if needed
 * 3. Returns the highlighted HTML
 * 
 * @param code - The code to highlight
 * @param lang - The language identifier
 * @returns HTML string with syntax highlighting
 */
export function* highlightCode(code: string, lang: string): Operation<string> {
  const normalizedLang = normalizeLanguage(lang)

  // Get or create highlighter, load language
  const [h, langLoaded] = yield* call(async () => {
    const highlighter = await getHighlighter()
    const loaded = await ensureLanguage(normalizedLang)
    return [highlighter, loaded] as const
  })

  // If language didn't load, fall back to plain text
  const effectiveLang = langLoaded ? normalizedLang : 'text'

  // Highlight!
  const html = h.codeToHtml(code, {
    lang: effectiveLang,
    theme: THEME,
  })

  return html
}

/**
 * Check if the highlighter is ready (for preload status).
 */
export function isHighlighterReady(): boolean {
  return highlighter !== null
}

/**
 * Preload the highlighter (call on app init for faster first highlight).
 * Returns a promise that resolves when ready.
 */
export function preloadHighlighter(): Promise<void> {
  return getHighlighter().then(() => undefined)
}

/**
 * Get list of currently loaded languages (for debugging).
 */
export function getLoadedLanguages(): string[] {
  return Array.from(loadedLanguages)
}
