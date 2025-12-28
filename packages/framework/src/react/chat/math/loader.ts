/**
 * math/loader.ts
 *
 * KaTeX initialization and rendering utilities.
 *
 * KaTeX is loaded lazily on first render to avoid blocking initial page load.
 * The loader handles:
 * - Lazy initialization
 * - Inline and block math rendering
 * - Error handling for invalid LaTeX
 */
import { call, type Operation } from 'effection'

// Lazy-loaded KaTeX instance
let katexInstance: typeof import('katex') | null = null
let initPromise: Promise<typeof import('katex')> | null = null

/**
 * Check if we're running in a browser environment.
 */
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'

/**
 * Initialize KaTeX.
 * Returns null if not in a browser environment.
 */
async function initKatex(): Promise<typeof import('katex') | null> {
  // KaTeX can technically run in Node, but we'll be consistent with mermaid
  if (!isBrowser) return null

  if (katexInstance) return katexInstance

  if (initPromise) return initPromise

  initPromise = (async () => {
    const katex = await import('katex')
    katexInstance = katex
    return katex
  })()

  return initPromise
}

/**
 * Check if KaTeX is already initialized.
 */
export function isKatexReady(): boolean {
  if (!isBrowser) return true // On server, consider it "ready" (will be skipped)
  return katexInstance !== null
}

/**
 * Preload KaTeX for faster first render.
 */
export function preloadKatex(): Operation<void> {
  return call(async () => {
    await initKatex()
  })
}

/**
 * Result of a math render attempt.
 */
export type MathRenderResult =
  | { success: true; html: string }
  | { success: false; error: string }

/**
 * Render LaTeX math to HTML.
 *
 * @param latex - The LaTeX source (without delimiters)
 * @param displayMode - true for block math ($$), false for inline ($)
 * @returns Result with HTML on success, or error message on failure
 */
export function renderMath(
  latex: string,
  displayMode: boolean
): Operation<MathRenderResult> {
  return call(async () => {
    try {
      const katex = await initKatex()

      // Skip on server
      if (!katex) {
        return {
          success: false,
          error: 'KaTeX requires browser environment',
        } as MathRenderResult
      }

      const html = katex.default.renderToString(latex, {
        displayMode,
        throwOnError: false,
        errorColor: '#ef4444', // Red for errors
        trust: false, // Don't allow potentially dangerous commands
        strict: 'warn',
        output: 'html',
      })

      return { success: true, html } as MathRenderResult
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message } as MathRenderResult
    }
  })
}

/**
 * Render math synchronously (for quick pass when KaTeX is already loaded).
 * Returns null if KaTeX is not ready.
 */
export function renderMathSync(
  latex: string,
  displayMode: boolean
): string | null {
  if (!katexInstance) return null

  try {
    return katexInstance.default.renderToString(latex, {
      displayMode,
      throwOnError: false,
      errorColor: '#ef4444',
      trust: false,
      strict: 'warn',
      output: 'html',
    })
  } catch {
    return null
  }
}
