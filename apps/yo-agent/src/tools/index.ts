/**
 * Tool Registry
 *
 * Exports all available tools for yo-agent.
 * This file is watched by Vite for HMR.
 *
 * All tools here are read-only and safe for "plan" mode.
 */
import { readFile } from './read-file.ts'
import { globFiles } from './glob-files.ts'
import { grepSearch } from './grep-search.ts'
import { gitStatus } from './git-status.ts'
import { gitLog } from './git-log.ts'
import { gitDiff } from './git-diff.ts'

export const tools = [
  // File system (read-only)
  readFile,
  globFiles,
  grepSearch,
  
  // Git (read-only)
  gitStatus,
  gitLog,
  gitDiff,
]
