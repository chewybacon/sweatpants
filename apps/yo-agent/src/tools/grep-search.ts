/**
 * Grep Search Tool
 *
 * Search file contents using regex patterns. Read-only, safe for plan mode.
 */
import { createIsomorphicTool } from '@tanstack/framework/chat/isomorphic-tools'
import { z } from 'zod'
import { call } from 'effection'
import fg from 'fast-glob'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

interface Match {
  file: string
  line: number
  content: string
}

export const grepSearch = createIsomorphicTool('grep_search')
  .description('Search file contents for a pattern')
  .parameters(
    z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      include: z
        .string()
        .optional()
        .default('**/*')
        .describe('Glob pattern for files to include (e.g., "**/*.ts")'),
      cwd: z
        .string()
        .optional()
        .describe('Directory to search from (defaults to current working directory)'),
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of matching lines to return'),
      caseSensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether the search should be case sensitive'),
    })
  )
  .context('headless')
  .authority('server')
  .server(function* (params) {
    const searchDir = params.cwd
      ? path.resolve(process.cwd(), params.cwd)
      : process.cwd()

    // Security: ensure search dir is within cwd
    const cwd = process.cwd()
    if (!searchDir.startsWith(cwd)) {
      return { error: 'Search directory must be within current working directory' }
    }

    try {
      const regex = new RegExp(params.pattern, params.caseSensitive ? 'g' : 'gi')

      // Find files matching the include pattern
      const files: string[] = yield* call(() =>
        fg(params.include, {
          cwd: searchDir,
          onlyFiles: true,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/*.min.js'],
        })
      )

      const matches: Match[] = []
      let truncated = false

      for (const file of files) {
        if (matches.length >= params.maxResults) {
          truncated = true
          break
        }

        const filePath = path.join(searchDir, file)
        
        try {
          const content: string = yield* call(() => fs.readFile(filePath, 'utf-8'))
          const lines = content.split('\n')

          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= params.maxResults) {
              truncated = true
              break
            }

            if (regex.test(lines[i])) {
              matches.push({
                file,
                line: i + 1,
                content: lines[i].slice(0, 200), // Truncate long lines
              })
            }
            // Reset regex lastIndex for next test
            regex.lastIndex = 0
          }
        } catch {
          // Skip files that can't be read (binary, permissions, etc.)
          continue
        }
      }

      return {
        pattern: params.pattern,
        include: params.include,
        matches,
        count: matches.length,
        truncated,
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return { error: `Search failed: ${error}` }
    }
  })
  .build()
