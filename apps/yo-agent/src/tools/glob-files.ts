/**
 * Glob Files Tool
 *
 * Find files matching a glob pattern. Read-only, safe for plan mode.
 */
import { createIsomorphicTool } from '@sweatpants/framework/chat/isomorphic-tools'
import { z } from 'zod'
import { call } from 'effection'
import fg from 'fast-glob'
import * as path from 'node:path'

export const globFiles = createIsomorphicTool('glob_files')
  .description('Find files matching a glob pattern')
  .parameters(
    z.object({
      pattern: z.string().describe('Glob pattern to match (e.g., "**/*.ts", "src/**/*.tsx")'),
      cwd: z
        .string()
        .optional()
        .describe('Directory to search from (defaults to current working directory)'),
      maxResults: z
        .number()
        .optional()
        .default(100)
        .describe('Maximum number of results to return'),
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
      const files: string[] = yield* call(() =>
        fg(params.pattern, {
          cwd: searchDir,
          onlyFiles: true,
          ignore: ['**/node_modules/**', '**/.git/**'],
        })
      )

      const truncated = files.length > params.maxResults
      const limitedFiles = truncated ? files.slice(0, params.maxResults) : files

      return {
        pattern: params.pattern,
        cwd: params.cwd || '.',
        files: limitedFiles,
        count: files.length,
        truncated,
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return { error: `Failed to glob files: ${error}` }
    }
  })
  .build()
