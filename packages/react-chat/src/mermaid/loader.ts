/**
 * mermaid/loader.ts
 * 
 * Mermaid initialization and rendering utilities.
 * 
 * Mermaid is loaded lazily on first render to avoid blocking initial page load.
 * The loader handles:
 * - Lazy initialization
 * - SVG rendering from mermaid code
 * - Error handling for invalid diagrams
 * - Server-side rendering safety (skips rendering on server)
 */
import { call, type Operation } from 'effection'

// Lazy-loaded mermaid instance
let mermaidInstance: typeof import('mermaid').default | null = null
let initPromise: Promise<typeof import('mermaid').default> | null = null
let idCounter = 0

/**
 * Check if we're running in a browser environment.
 */
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'

/**
 * Initialize mermaid with sensible defaults.
 * This is called lazily on first render.
 * Returns null if not in a browser environment.
 */
async function initMermaid(): Promise<typeof import('mermaid').default | null> {
  // Mermaid requires a DOM - skip on server
  if (!isBrowser) return null
  
  if (mermaidInstance) return mermaidInstance
  
  if (initPromise) return initPromise
  
  initPromise = (async () => {
    const mermaid = (await import('mermaid')).default
    
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict', // Important for user-provided content
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      flowchart: {
        htmlLabels: true,
        curve: 'basis',
      },
      sequence: {
        diagramMarginX: 10,
        diagramMarginY: 10,
      },
      themeVariables: {
        // Dark theme colors that work well on dark backgrounds
        primaryColor: '#3b82f6',      // Blue
        primaryTextColor: '#f8fafc',
        primaryBorderColor: '#60a5fa',
        lineColor: '#94a3b8',
        secondaryColor: '#1e293b',
        tertiaryColor: '#334155',
        background: '#0f172a',
        mainBkg: '#1e293b',
        nodeBorder: '#60a5fa',
        clusterBkg: '#1e293b',
        clusterBorder: '#475569',
        titleColor: '#f8fafc',
        edgeLabelBackground: '#1e293b',
      },
    })
    
    mermaidInstance = mermaid
    return mermaid
  })()
  
  return initPromise
}

/**
 * Check if mermaid is already initialized.
 * Returns true on server (we skip mermaid rendering there).
 */
export function isMermaidReady(): boolean {
  if (!isBrowser) return true // On server, consider it "ready" (will be skipped)
  return mermaidInstance !== null
}

/**
 * Preload mermaid for faster first render.
 * Call this early (e.g., on page load) to warm up the cache.
 */
export function preloadMermaid(): Operation<void> {
  return call(async () => {
    await initMermaid()
  })
}

/**
 * Result of a mermaid render attempt.
 */
export type MermaidRenderResult = 
  | { success: true; svg: string }
  | { success: false; error: string }

/**
 * Render mermaid code to SVG.
 * 
 * This is an Effection operation that:
 * 1. Lazily initializes mermaid if needed
 * 2. Renders the diagram to SVG
 * 3. Returns a result indicating success or failure
 * 
 * On failure, the processor should fall back to quick-highlighted code.
 * On server, returns a "skip" result (mermaid requires DOM).
 * 
 * @param code - The mermaid diagram code (without fence markers)
 * @returns Result with SVG on success, or error message on failure
 */
export function renderMermaid(code: string): Operation<MermaidRenderResult> {
  return call(async () => {
    try {
      const mermaid = await initMermaid()
      
      // Skip on server - mermaid requires DOM
      if (!mermaid) {
        return { success: false, error: 'Mermaid requires browser environment' } as MermaidRenderResult
      }
      
      const id = `mermaid-${++idCounter}`
      
      // Validate the diagram first
      const isValid = await mermaid.parse(code, { suppressErrors: true })
      if (!isValid) {
        return { success: false, error: 'Invalid mermaid syntax' } as MermaidRenderResult
      }
      
      // Render to SVG
      const { svg } = await mermaid.render(id, code)
      
      return { success: true, svg: wrapSvg(svg) } as MermaidRenderResult
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message } as MermaidRenderResult
    }
  })
}

/**
 * Wrap SVG in a container for consistent styling.
 */
function wrapSvg(svg: string): string {
  return `<div class="mermaid-diagram">${svg}</div>`
}
