/**
 * Git Log Tool
 *
 * Shows commit history. Read-only, safe for plan mode.
 */
import { createTool } from '@sweatpants/framework/chat/tools'
import { z } from 'zod'
import { call } from 'effection'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface Commit {
  hash: string
  author: string
  date: string
  message: string
}

export const gitLog = createTool('git_log')
  .description('Show commit history')
  .parameters(
    z.object({
      count: z
        .number()
        .optional()
        .default(10)
        .describe('Number of commits to show'),
      file: z
        .string()
        .optional()
        .describe('Show commits for a specific file'),
      oneline: z
        .boolean()
        .optional()
        .default(false)
        .describe('Show abbreviated commit info'),
    })
  )
  .execute(function* (params) {
    try {
      const fileArg = params.file ? ` -- "${params.file}"` : ''
      
      if (params.oneline) {
        const { stdout }: { stdout: string } = yield* call(() =>
          execAsync(`git log --oneline -${params.count}${fileArg}`, { cwd: process.cwd() })
        )
        return { output: stdout.trim() }
      }

      // Use format for structured output
      const format = '%H%n%an%n%aI%n%s%n---COMMIT---'
      const { stdout }: { stdout: string } = yield* call(() =>
        execAsync(`git log --format="${format}" -${params.count}${fileArg}`, { cwd: process.cwd() })
      )

      const commits: Commit[] = stdout
        .split('---COMMIT---')
        .filter(Boolean)
        .map(block => {
          const parts = block.trim().split('\n')
          return { 
            hash: parts[0] ?? '', 
            author: parts[1] ?? '', 
            date: parts[2] ?? '', 
            message: parts[3] ?? '' 
          }
        })

      return { commits, count: commits.length }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return { error: `Git log failed: ${error}` }
    }
  })
