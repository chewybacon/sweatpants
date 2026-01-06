/**
 * Git Diff Tool
 *
 * Shows changes between commits, working tree, etc. Read-only, safe for plan mode.
 */
import { createIsomorphicTool } from '@sweatpants/framework/chat/isomorphic-tools'
import { z } from 'zod'
import { call } from 'effection'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export const gitDiff = createIsomorphicTool('git_diff')
  .description('Show changes between commits, working tree, etc.')
  .parameters(
    z.object({
      file: z
        .string()
        .optional()
        .describe('Show diff for a specific file'),
      staged: z
        .boolean()
        .optional()
        .default(false)
        .describe('Show staged changes (--cached)'),
      commit: z
        .string()
        .optional()
        .describe('Compare with a specific commit (e.g., HEAD~1, abc123)'),
      stat: z
        .boolean()
        .optional()
        .default(false)
        .describe('Show diffstat instead of full diff'),
    })
  )
  .context('headless')
  .authority('server')
  .server(function* (params) {
    try {
      const args: string[] = ['git', 'diff']

      if (params.staged) {
        args.push('--cached')
      }

      if (params.stat) {
        args.push('--stat')
      }

      if (params.commit) {
        args.push(params.commit)
      }

      if (params.file) {
        args.push('--', `"${params.file}"`)
      }

      const { stdout }: { stdout: string } = yield* call(() =>
        execAsync(args.join(' '), { 
          cwd: process.cwd(),
          maxBuffer: 1024 * 1024 * 10, // 10MB for large diffs
        })
      )

      const diff = stdout.trim()
      
      if (!diff) {
        return { 
          output: params.staged 
            ? 'No staged changes' 
            : 'No unstaged changes',
          empty: true,
        }
      }

      // Truncate very large diffs
      const maxLength = 50000
      if (diff.length > maxLength) {
        return {
          output: diff.slice(0, maxLength) + '\n\n... (diff truncated, too large)',
          truncated: true,
          totalLength: diff.length,
        }
      }

      return { output: diff, empty: false }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return { error: `Git diff failed: ${error}` }
    }
  })
  .build()
