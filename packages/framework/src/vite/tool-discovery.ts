/**
 * Tool Discovery Vite Plugin
 *
 * Scans a directory for tool files and generates a type-safe registry.
 *
 * Features:
 * - File-based discovery (no manual imports)
 * - Watches for changes in dev mode
 * - Generates type-safe registry with const assertions
 * - Supports both default and named exports
 */
import type { Plugin } from 'vite'
import { readFile, writeFile, mkdir, access } from 'fs/promises'
import { join, dirname, relative, posix } from 'path'
import fg from 'fast-glob'
import type {
  ToolDiscoveryOptions,
  ResolvedToolDiscoveryOptions,
  DiscoveredTool,
} from './types'
import { resolveToolDiscoveryOptions } from './types'

export function toolDiscoveryPlugin(
  userOptions: ToolDiscoveryOptions = {}
): Plugin {
  const options = resolveToolDiscoveryOptions(userOptions)
  let root: string

  return {
    name: '@tanstack/framework:tool-discovery',

    configResolved(config) {
      root = config.root
    },

    async buildStart() {
      await generateRegistry(root, options)
    },

    configureServer(server) {
      // Watch the tools directory for changes
      const toolsDir = join(root, options.dir)

      server.watcher.add(toolsDir)

      server.watcher.on('add', async (file) => {
        if (isToolFile(file, toolsDir, options)) {
          log(options, 'normal', `[tool-discovery] New tool file: ${relative(root, file)}`)
          await generateRegistry(root, options)
        }
      })

      server.watcher.on('unlink', async (file) => {
        if (isToolFile(file, toolsDir, options)) {
          log(options, 'normal', `[tool-discovery] Removed tool file: ${relative(root, file)}`)
          await generateRegistry(root, options)
        }
      })

      server.watcher.on('change', async (file) => {
        if (isToolFile(file, toolsDir, options)) {
          log(options, 'verbose', `[tool-discovery] Changed tool file: ${relative(root, file)}`)
          await generateRegistry(root, options)
        }
      })
    },
  }
}

function isToolFile(
  file: string,
  toolsDir: string,
  options: ResolvedToolDiscoveryOptions
): boolean {
  if (!file.startsWith(toolsDir)) return false
  const relPath = relative(toolsDir, file)

  // Check if it matches the pattern and is not ignored
  const isMatch = fg.isDynamicPattern(options.pattern)
    ? true // Let fast-glob handle it
    : relPath.endsWith('.ts') || relPath.endsWith('.tsx')

  const isIgnored = options.ignore.some((pattern) => {
    if (pattern.includes('*')) {
      return fg.isDynamicPattern(pattern) && relPath.includes(pattern.replace(/\*/g, ''))
    }
    return relPath.includes(pattern)
  })

  return isMatch && !isIgnored
}

async function generateRegistry(
  root: string,
  options: ResolvedToolDiscoveryOptions
): Promise<void> {
  const toolsDir = join(root, options.dir)
  const outFile = join(root, options.outFile)

  // Check if tools directory exists
  try {
    await access(toolsDir)
  } catch {
    log(options, 'verbose', `[tool-discovery] Tools directory not found: ${options.dir}`)
    // Generate empty registry
    await writeRegistryFile(outFile, [], options)
    return
  }

  // Find all tool files
  const pattern = posix.join(options.dir, options.pattern)
  const files = await fg(pattern, {
    cwd: root,
    ignore: options.ignore.map((p) => posix.join(options.dir, p)),
    absolute: true,
  })

  if (files.length === 0) {
    log(options, 'normal', `[tool-discovery] No tool files found in ${options.dir}`)
    await writeRegistryFile(outFile, [], options)
    return
  }

  // Discover tools from each file
  const tools: DiscoveredTool[] = []

  for (const file of files) {
    const discovered = await discoverToolsInFile(file, toolsDir, options)
    tools.push(...discovered)
  }

  log(options, 'normal', `[tool-discovery] Found ${tools.length} tools in ${files.length} files`)

  // Generate registry
  await writeRegistryFile(outFile, tools, options)

  log(options, 'normal', `[tool-discovery] Generated ${relative(root, outFile)}`)
}

async function discoverToolsInFile(
  file: string,
  toolsDir: string,
  options: ResolvedToolDiscoveryOptions
): Promise<DiscoveredTool[]> {
  const content = await readFile(file, 'utf-8')
  return discoverToolsInContent(content, file, toolsDir, options)
}

/**
 * Parse file content to discover tools.
 * Exported for testing - allows testing without file I/O.
 */
export function discoverToolsInContent(
  content: string,
  file: string,
  toolsDir: string,
  options: ResolvedToolDiscoveryOptions
): DiscoveredTool[] {
  const tools: DiscoveredTool[] = []

  // Look for createIsomorphicTool calls
  // Pattern 1: export const foo = createIsomorphicTool('tool_name')
  // Pattern 2: export default createIsomorphicTool('tool_name')
  // Pattern 3: const foo = createIsomorphicTool('tool_name') ... export { foo }
  // Pattern 4: const foo = createIsomorphicTool('tool_name') ... export default foo

  const fnName = options.exportFunctionName

  // Named export with inline definition
  // export const guessCard = createIsomorphicTool('guess_card')
  const namedExportRegex = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*${fnName}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    'g'
  )

  let match: RegExpExecArray | null
  while ((match = namedExportRegex.exec(content)) !== null) {
    const [, exportName, toolName] = match
    if (!exportName || !toolName) continue
    tools.push({
      filePath: relative(toolsDir, file),
      absolutePath: file,
      exportName,
      toolName,
      variableName: exportName,
    })
  }

  // Default export with inline definition
  // export default createIsomorphicTool('guess_card')
  const defaultExportRegex = new RegExp(
    `export\\s+default\\s+${fnName}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    'g'
  )

  while ((match = defaultExportRegex.exec(content)) !== null) {
    const [, toolName] = match
    if (!toolName) continue
    tools.push({
      filePath: relative(toolsDir, file),
      absolutePath: file,
        // exportName: undefined, // default export
      toolName,
      variableName: toCamelCase(toolName),
    })
  }

  // Variable definition followed by default export
  // const guessCard = createIsomorphicTool('guess_card')
  // ... later ...
  // export default guessCard
  const varDefRegex = new RegExp(
    `const\\s+(\\w+)\\s*=\\s*${fnName}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    'g'
  )

  const varDefs = new Map<string, string>()
  while ((match = varDefRegex.exec(content)) !== null) {
    const [, varName, toolName] = match
    if (!varName || !toolName) continue
    varDefs.set(varName, toolName)
  }

  // Check for default export of a variable
  const defaultExportVarRegex = /export\s+default\s+(\w+)\s*(?:;|\n|$)/g
  while ((match = defaultExportVarRegex.exec(content)) !== null) {
    const [, varName] = match
    if (!varName) continue
    const toolName = varDefs.get(varName)
    if (toolName) {
      // Check if we already added this via inline detection
      const alreadyAdded = tools.some((t) => t.toolName === toolName)
      if (!alreadyAdded) {
        tools.push({
          filePath: relative(toolsDir, file),
          absolutePath: file,
            // exportName: undefined, // default export
          toolName,
          variableName: varName,
        })
      }
    }
  }

  // Check for named exports of variables: export { foo } or export { foo as bar }
  const namedExportBraceRegex = /export\s*\{([^}]+)\}/g
  while ((match = namedExportBraceRegex.exec(content)) !== null) {
      const exportGroup = match[1]
      if (!exportGroup) continue
      const exports = exportGroup.split(',').map((s) => s.trim())
    for (const exp of exports) {
      // Handle 'foo' or 'foo as bar'
        const parts = exp.split(/\s+as\s+/)
        const rawVar = parts[0]
        if (!rawVar) continue
        const varName = rawVar.trim()
        const exportName = parts[1]?.trim() ?? varName
      if (!varName) continue
      const toolName = varDefs.get(varName)
      if (toolName) {
        // Check if we already added this
        const alreadyAdded = tools.some((t) => t.toolName === toolName)
        if (!alreadyAdded) {
          tools.push({
            filePath: relative(toolsDir, file),
            absolutePath: file,
            exportName,
            toolName,
            variableName: exportName,
          })
        }
      }
    }
  }

  return tools
}

async function writeRegistryFile(
  outFile: string,
  tools: DiscoveredTool[],
  options: ResolvedToolDiscoveryOptions
): Promise<void> {
  // Ensure output directory exists
  const outDir = dirname(outFile)
  await mkdir(outDir, { recursive: true })

  const content = generateRegistryContent(tools, outFile, options)
  await writeFile(outFile, content)
}

/**
 * Generate registry file content.
 * Exported for testing - allows testing output format without file I/O.
 */
export function generateRegistryContent(
  tools: DiscoveredTool[],
  outFile: string,
  options: ResolvedToolDiscoveryOptions
): string {
  // Generate imports and registry
  const imports: string[] = []
  const registryEntries: string[] = []
  const typeEntries: string[] = []

  // Sort tools for deterministic output
  const sortedTools = [...tools].sort((a, b) => a.toolName.localeCompare(b.toolName))

  for (const tool of sortedTools) {
    // Calculate relative import path from output file to tool file
    const importPath = calculateImportPath(outFile, tool.absolutePath)

    if (tool.exportName) {
      imports.push(`import { ${tool.exportName} } from '${importPath}'`)
    } else {
      imports.push(`import ${tool.variableName} from '${importPath}'`)
    }

    registryEntries.push(`  ${tool.variableName},`)
    typeEntries.push(`  | '${tool.toolName}'`)
  }

  return `/**
 * Tool Registry (auto-generated)
 *
 * DO NOT EDIT - This file is generated by @tanstack/framework
 * Regenerate by modifying files in ${options.dir}/
 */

${imports.join('\n')}

/**
 * All discovered tools as a const object.
 * Use this for type-safe tool access.
 */
export const tools = {
${registryEntries.join('\n')}
} as const

/**
 * Array of all tools (for runtime iteration).
 */
export const toolList = Object.values(tools)

/**
 * Union type of all tool names.
 */
export type ToolName =
${typeEntries.length > 0 ? typeEntries.join('\n') : '  never'}

/**
 * Get a tool by name (type-safe).
 */
export function getTool<T extends ToolName>(name: T) {
  return toolList.find((t) => t.name === name)
}

/**
 * Type helper: Extract the tool type by name.
 */
export type ToolByName<T extends ToolName> = (typeof tools)[keyof typeof tools] & { name: T }
`
}

// Exported for testing
export function calculateImportPath(from: string, to: string): string {
  let rel = relative(dirname(from), to)

  // Ensure it starts with ./ or ../
  if (!rel.startsWith('.') && !rel.startsWith('/')) {
    rel = './' + rel
  }

  // Remove .ts extension for import
  rel = rel.replace(/\.tsx?$/, '')

  // Normalize to posix paths
  rel = rel.split('\\').join('/')

  return rel
}

// Exported for testing
export function toCamelCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('')
}

function log(
  options: ResolvedToolDiscoveryOptions,
  level: 'verbose' | 'normal',
  message: string
): void {
  if (options.logLevel === 'silent') return
  if (level === 'verbose' && options.logLevel !== 'verbose') return
  console.log(message)
}
