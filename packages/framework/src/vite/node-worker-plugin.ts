/**
 * Node Worker Plugin for Vite 7
 *
 * Provides ?modulePath and ?nodeWorker import suffixes for Node.js worker_threads.
 * Compatible with Vite 7.x.
 *
 * Usage:
 *   import workerUrl from './my-worker.ts?modulePath'
 *   // Returns URL object pointing to bundled worker
 *
 *   import createWorker from './my-worker.ts?nodeWorker'
 *   // Returns factory function: (options?) => Worker
 *
 * In dev mode:
 *   - Transpiles TypeScript using Vite's transformWithEsbuild
 *   - Rewrites imports to file:// URLs
 *   - Caches transpiled files in node_modules/.vite/node-worker/
 *
 * In build mode:
 *   - Emits worker as a separate Rollup chunk
 *   - Returns relative path via import.meta.url resolution
 */
import type { Plugin, ResolvedConfig } from 'vite'
import { transformWithEsbuild, normalizePath } from 'vite'
import { pathToFileURL, URL as NodeURL } from 'node:url'
import { createHash } from 'node:crypto'
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import MagicString from 'magic-string'

const DEBUG = process.env['VNW_DEBUG'] === '1'

// Query parameter patterns
const NODE_WORKER_RE = /[?&]nodeWorker(?:&|$)/
const MODULE_PATH_RE = /[?&]modulePath(?:&|$)/
const NODE_WORKER_ASSET_RE = /__VITE_NODE_WORKER_ASSET__([\w$]+)__/g

// Node.js built-in modules (don't rewrite these)
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events',
  'fs', 'fs/promises', 'http', 'http2', 'https', 'module', 'net', 'os',
  'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
])

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

function cleanUrl(url: string): string {
  return url.replace(/[?#].*$/, '')
}

function parseQuery(id: string): Record<string, string> | null {
  const url = new NodeURL(id, 'file:')
  if (!url.search) return null
  return Object.fromEntries(url.searchParams)
}

function toFileUrl(p: string): string {
  return pathToFileURL(path.resolve(p)).href
}

function toRelativePath(filename: string, importer: string): string {
  const from = path.posix.dirname(importer)
  const rel = path.posix.relative(from, filename)
  const norm = normalizePath(rel)
  return norm.startsWith('.') ? norm : `./${norm}`
}

function fileExists(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

const PROBE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']

function tryResolveFile(base: string): string | null {
  const ext = path.extname(base)
  const baseNoExt = ext ? base.slice(0, -ext.length) : base

  const candidates: string[] = []

  if (ext) {
    candidates.push(base)
    candidates.push(baseNoExt + '.ts', baseNoExt + '.tsx', baseNoExt + '.mts')
    candidates.push(baseNoExt + '.js', baseNoExt + '.mjs', baseNoExt + '.cjs')
  } else {
    for (const e of PROBE_EXTS) {
      candidates.push(baseNoExt + e)
    }
  }

  // Try index files
  for (const e of PROBE_EXTS.slice(1)) {
    candidates.push(path.join(base, `index${e}`))
  }

  for (const file of candidates) {
    if (fileExists(file)) return file
  }
  return null
}

interface RewriteOptions {
  root: string
  aliases: Array<{ find: string | RegExp; replacement: string }>
  cacheDir: string
}

/**
 * Recursively rewrite a worker entry file:
 * - Transpile TypeScript to JavaScript
 * - Rewrite all imports to file:// URLs
 * - Cache results for performance
 */
async function rewriteWorkerEntry(
  entryFile: string,
  options: RewriteOptions
): Promise<string> {
  const { root, aliases, cacheDir } = options
  const cache = new Map<string, string>() // fsPath -> output URL
  const active = new Set<string>() // prevent cycles

  function applyAliases(spec: string): string {
    for (const { find, replacement } of aliases) {
      if (find instanceof RegExp) {
        if (find.test(spec)) return spec.replace(find, replacement)
      } else if (typeof find === 'string') {
        if (spec.startsWith(find)) return replacement + spec.slice(find.length)
      }
    }
    return spec
  }

  function resolveToFs(spec: string, fromFile: string): string | null {
    if (!spec) return null

    // External URLs
    if (/^(?:https?:|data:)/.test(spec)) return null

    // Node built-ins
    const noNodePrefix = spec.replace(/^node:/, '')
    const isBare = !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('file:')
    if (isBare && NODE_BUILTINS.has(noNodePrefix)) return null

    // Apply aliases for bare imports
    if (isBare) {
      const aliased = applyAliases(spec)
      if (aliased !== spec) spec = aliased
      else return null // Can't resolve bare imports without Vite resolver in dev
    }

    // file: URLs
    if (spec.startsWith('file:')) {
      try {
        return new NodeURL(spec).pathname
      } catch {
        return null
      }
    }

    // Apply aliases again
    spec = applyAliases(spec)

    // Resolve to absolute path
    let base: string
    if (path.isAbsolute(spec)) {
      base = spec.startsWith('/') ? path.resolve(root, spec.slice(1)) : spec
    } else if (spec.startsWith('.')) {
      base = path.resolve(path.dirname(fromFile), spec)
    } else {
      base = path.resolve(root, spec)
    }

    return tryResolveFile(base)
  }

  async function rewriteModule(fsPath: string): Promise<string> {
    // Skip non-JS files
    if (/\.(json|css|scss|sass|less|svg|png|jpe?g|gif|webp)$/i.test(fsPath)) {
      return toFileUrl(fsPath)
    }

    // Cycle detection
    if (active.has(fsPath)) {
      return toFileUrl(fsPath)
    }

    // Check cache
    if (cache.has(fsPath)) {
      return cache.get(fsPath)!
    }

    let code: string
    try {
      code = readFileSync(fsPath, 'utf8')
    } catch (err) {
      if (DEBUG) console.error('[node-worker-plugin] Failed to read:', fsPath, err)
      throw err
    }

    // Initial cache entry
    const originalUrl = toFileUrl(fsPath)
    cache.set(fsPath, originalUrl)
    active.add(fsPath)

    try {
      // Transpile TypeScript
      const ext = path.extname(fsPath).toLowerCase()
      const isTsLike = ['.ts', '.tsx', '.mts', '.cts'].includes(ext)
      
      if (isTsLike) {
        try {
          const result = await transformWithEsbuild(code, fsPath, {
            loader: ext === '.tsx' ? 'tsx' : 'ts',
            format: 'esm',
            sourcemap: false,
            target: 'esnext',
          })
          if (result?.code) {
            code = result.code
          }
        } catch (e) {
          if (DEBUG) console.warn('[node-worker-plugin] Transform failed:', fsPath, e)
        }
      }

      // Rewrite imports using regex (fast but not perfect)
      const importPatterns = [
        /(import\s+[^'";]*?from\s*['"])([^'"\n]+)(['"])/g,
        /(export\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\*|[\w$,\s]*)\s*from\s*['"])([^'"\n]+)(['"])/g,
        /(import\s*\(\s*['"])([^'"\n]+)(['"]\s*\))/g,
        /(import\s*['"])([^'"\n]+)(['"])/g,
      ]

      for (const pattern of importPatterns) {
        const ms = new MagicString(code)
        pattern.lastIndex = 0
        
        for (const match of code.matchAll(pattern)) {
          const spec = match[2]
          if (!spec) continue
          
          const start = match.index! + match[1]!.length
          const end = start + spec.length
          
          const childFs = resolveToFs(spec, fsPath)
          if (childFs && childFs !== fsPath) {
            const childUrl = await rewriteModule(childFs)
            if (childUrl !== spec) {
              ms.overwrite(start, end, childUrl)
            }
          }
        }
        
        code = ms.toString()
      }

      // Write to cache directory
      mkdirSync(cacheDir, { recursive: true })
      const hash = sha1(fsPath + '|' + code).slice(0, 12)
      const outFile = path.join(cacheDir, `${hash}.mjs`)
      
      if (!fileExists(outFile)) {
        writeFileSync(outFile, code + `\n//# sourceURL=${originalUrl}`)
        if (DEBUG) console.log('[node-worker-plugin] Emitted:', outFile)
      }

      const url = toFileUrl(outFile)
      cache.set(fsPath, url)
      return url
    } finally {
      active.delete(fsPath)
    }
  }

  return rewriteModule(entryFile)
}

/**
 * Vite plugin for Node.js worker_threads support.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { nodeWorkerPlugin } from '@sweatpants/framework/vite'
 *
 * export default defineConfig({
 *   plugins: [nodeWorkerPlugin()],
 * })
 * ```
 */
export function nodeWorkerPlugin(): Plugin {
  let config: ResolvedConfig
  let isServe = false
  let root = process.cwd()
  let aliases: Array<{ find: string | RegExp; replacement: string }> = []
  let cacheDir: string

  return {
    name: '@sweatpants/node-worker',
    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = resolvedConfig
      isServe = config.command === 'serve'
      root = config.root || root
      cacheDir = path.join(config.cacheDir || path.join(root, 'node_modules/.vite'), 'node-worker')
      
      // Extract aliases from config
      const rawAliases = config.resolve?.alias
      if (Array.isArray(rawAliases)) {
        aliases = rawAliases.map(e => ({
          find: e.find,
          replacement: e.replacement,
        }))
      } else if (rawAliases && typeof rawAliases === 'object') {
        aliases = Object.entries(rawAliases).map(([find, replacement]) => ({
          find,
          replacement: replacement as string,
        }))
      }
    },

    resolveId(id, importer) {
      if (!NODE_WORKER_RE.test(id) && !MODULE_PATH_RE.test(id)) {
        return null
      }
      return id + (importer ? `&importer=${importer}` : '')
    },

    async load(id) {
      const query = parseQuery(id)
      if (!query) return

      const isNodeWorker = NODE_WORKER_RE.test(id)
      const isModulePath = MODULE_PATH_RE.test(id)
      
      if (!isNodeWorker && !isModulePath) return

      const cleanPath = cleanUrl(id)
      const importerFile = (query['importer'] || '').replace(/\?.*$/, '')

      // Resolve the actual file path
      let absId: string | null = null
      
      // Try Vite's resolver first
      const resolved = await this.resolve(cleanPath, importerFile || undefined)
      if (resolved?.id) {
        absId = cleanUrl(resolved.id)
      }
      
      // Fallback resolution
      if (!absId || !fileExists(absId)) {
        if (cleanPath.startsWith('/')) {
          absId = path.resolve(root, cleanPath.slice(1))
        } else if (importerFile) {
          absId = path.resolve(path.dirname(importerFile), cleanPath)
        } else {
          absId = path.resolve(root, cleanPath)
        }
      }

      if (!fileExists(absId)) {
        this.error(`Cannot resolve worker file: ${cleanPath}`)
      }

      if (isServe) {
        // DEV MODE: Rewrite imports and return file:// URL
        const entryUrl = await rewriteWorkerEntry(absId, { root, aliases, cacheDir })

        if (isModulePath) {
          return `export default new URL(${JSON.stringify(entryUrl)})`
        }
        
        return `
          import { Worker } from 'node:worker_threads';
          const url = new URL(${JSON.stringify(entryUrl)});
          export default function createWorker(options) { return new Worker(url, options); }
        `
      }

      // BUILD MODE: Emit as separate chunk
      const base = path.basename(cleanPath, path.extname(cleanPath))
      const refId = this.emitFile({
        type: 'chunk',
        id: absId,
        fileName: `${base}.worker.mjs`,
      })

      const placeholder = `__VITE_NODE_WORKER_ASSET__${refId}__`

      if (isModulePath) {
        return `export default ${placeholder}`
      }
      
      return `
        import { Worker } from 'node:worker_threads';
        export default function createWorker(options) {
          return new Worker(new URL(${placeholder}, import.meta.url), options);
        }
      `
    },

    renderChunk(code, chunk) {
      if (!NODE_WORKER_ASSET_RE.test(code)) return

      const s = new MagicString(code)
      NODE_WORKER_ASSET_RE.lastIndex = 0

      let match
      while ((match = NODE_WORKER_ASSET_RE.exec(code))) {
        const [full, refId] = match
        let workerFileName: string
        
        try {
          workerFileName = this.getFileName(refId!)
        } catch {
          continue // Unknown refId, skip
        }

        const rel = toRelativePath(workerFileName, chunk.fileName)
        s.overwrite(match.index, match.index + full.length, JSON.stringify(rel))
      }

      return {
        code: s.toString(),
        map: s.generateMap({ hires: true }),
      }
    },
  }
}

export default nodeWorkerPlugin
