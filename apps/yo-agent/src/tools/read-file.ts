/**
 * Read File Tool
 *
 * Reads the contents of a file. Read-only, safe for plan mode.
 */
import { createIsomorphicTool } from '@tanstack/framework/chat/isomorphic-tools'
import { z } from 'zod'
import { call } from 'effection'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export const readFile = createIsomorphicTool('read_file')
  .description('Read the contents of a file')
  .parameters(
    z.object({
      path: z.string().describe('Path to the file to read'),
      maxLines: z
        .number()
        .optional()
        .default(500)
        .describe('Maximum number of lines to read'),
    })
  )
  .context('headless')
  .authority('server')
  .server(function* (params) {
    const filePath = path.resolve(process.cwd(), params.path)

    // Security: ensure path is within cwd
    const cwd = process.cwd()
    if (!filePath.startsWith(cwd)) {
      return { error: 'Path must be within current working directory' }
    }

    try {
      const content: string = yield* call(() => fs.readFile(filePath, 'utf-8'))

      // Limit lines if needed
      const lines = content.split('\n')
      const truncated = lines.length > params.maxLines
      const limitedContent = truncated
        ? lines.slice(0, params.maxLines).join('\n') + `\n... (${lines.length - params.maxLines} more lines)`
        : content

      return {
        path: params.path,
        content: limitedContent,
        lineCount: lines.length,
        truncated,
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return { error: `Failed to read file: ${error}` }
    }
  })
  .build()
