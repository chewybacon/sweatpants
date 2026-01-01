/**
 * Git Status Tool
 *
 * Shows the working tree status. Read-only, safe for plan mode.
 */
import { createIsomorphicTool } from '@tanstack/framework/chat/isomorphic-tools'
import { z } from 'zod'
import { call } from 'effection'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export const gitStatus = createIsomorphicTool('git_status')
  .description('Show the working tree status (modified, staged, untracked files)')
  .parameters(
    z.object({
      short: z
        .boolean()
        .optional()
        .default(false)
        .describe('Show short-format output'),
    })
  )
  .context('headless')
  .authority('server')
  .server(function* (params) {
    try {
      const args = params.short ? '--short' : '--porcelain=v1'
      const { stdout }: { stdout: string } = yield* call(() =>
        execAsync(`git status ${args}`, { cwd: process.cwd() })
      )

      if (params.short) {
        return { output: stdout.trim() || 'Nothing to commit, working tree clean' }
      }

      // Parse porcelain output into structured data
      const lines = stdout.trim().split('\n').filter(Boolean)
      const files = lines.map(line => {
        const status = line.slice(0, 2)
        const file = line.slice(3)
        return {
          status,
          file,
          staged: status[0] !== ' ' && status[0] !== '?',
          modified: status[1] === 'M',
          untracked: status === '??',
          deleted: status.includes('D'),
          added: status.includes('A'),
        }
      })

      const staged = files.filter(f => f.staged)
      const unstaged = files.filter(f => !f.staged && !f.untracked)
      const untracked = files.filter(f => f.untracked)

      return {
        staged: staged.map(f => f.file),
        unstaged: unstaged.map(f => f.file),
        untracked: untracked.map(f => f.file),
        clean: files.length === 0,
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return { error: `Git status failed: ${error}` }
    }
  })
  .build()
