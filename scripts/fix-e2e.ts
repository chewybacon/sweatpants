#!/usr/bin/env npx tsx
/**
 * E2E Test Fixer - Interactive CLI for fixing failing e2e tests one by one
 *
 * Usage: pnpm tsx scripts/fix-e2e.ts
 *
 * Commands:
 *   n/Enter - Next test
 *   p       - Previous test
 *   r       - Run current test (headed mode for debugging)
 *   R       - Run current test (headless)
 *   s       - Mark as skipped (auto-advances)
 *   f       - Mark as fixed (auto-advances)
 *   l       - List all tests with status
 *   q       - Quit
 */
import { execSync } from 'child_process'
import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'

// ============================================================================
// Types
// ============================================================================

interface FailingTest {
  file: string
  grep: string
  category: string
  notes?: string
  status: 'pending' | 'fixed' | 'skipped'
}

// ============================================================================
// Data Loading
// ============================================================================

function loadTests(jsonlPath: string): FailingTest[] {
  const content = fs.readFileSync(jsonlPath, 'utf-8')
  return content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const parsed = JSON.parse(line)
      return { ...parsed, status: 'pending' as const }
    })
}

// ============================================================================
// Rendering
// ============================================================================

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H')
}

function render(tests: FailingTest[], currentIndex: number) {
  clearScreen()

  const test = tests[currentIndex]
  if (!test) return

  const pending = tests.filter((t) => t.status === 'pending').length
  const fixed = tests.filter((t) => t.status === 'fixed').length
  const skipped = tests.filter((t) => t.status === 'skipped').length

  const statusIcon = {
    pending: '\x1b[33m○\x1b[0m',
    fixed: '\x1b[32m✓\x1b[0m',
    skipped: '\x1b[90m–\x1b[0m',
  }

  console.log(`
  \x1b[1mE2E Test Fixer\x1b[0m (${currentIndex + 1}/${tests.length})
  ───────────────────────────────────────────

  File:     \x1b[36m${test.file}\x1b[0m
  Test:     ${test.grep}
  Category: \x1b[33m${test.category}\x1b[0m
  Notes:    ${test.notes || '–'}
  Status:   ${statusIcon[test.status]} ${test.status}

  ───────────────────────────────────────────
  Progress: ${fixed} fixed, ${skipped} skipped, ${pending} pending

  \x1b[2m[n]ext  [p]rev  [r]un headed  [R]un headless
  [f]ixed [s]kip  [l]ist        [q]uit\x1b[0m

`)
}

function renderList(tests: FailingTest[], currentIndex: number) {
  clearScreen()

  const statusIcon = {
    pending: '\x1b[33m○\x1b[0m',
    fixed: '\x1b[32m✓\x1b[0m',
    skipped: '\x1b[90m–\x1b[0m',
  }

  console.log(`
  \x1b[1mAll Failing Tests\x1b[0m
  ─────────────────
`)

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i]!
    const pointer = i === currentIndex ? '\x1b[36m>\x1b[0m' : ' '
    const shortFile = test.file.replace('apps/yo-chat/', '')
    console.log(`  ${pointer} ${statusIcon[test.status]} ${i + 1}. [${test.category}] ${shortFile}`)
    console.log(`      ${test.grep.slice(0, 60)}${test.grep.length > 60 ? '...' : ''}`)
  }

  console.log(`
  \x1b[2mPress any key to return...\x1b[0m
`)
}

function renderSummary(tests: FailingTest[]) {
  clearScreen()

  const pending = tests.filter((t) => t.status === 'pending').length
  const fixed = tests.filter((t) => t.status === 'fixed').length
  const skipped = tests.filter((t) => t.status === 'skipped').length

  console.log(`
  \x1b[1mSession Summary\x1b[0m
  ───────────────

  \x1b[32m✓ Fixed:\x1b[0m   ${fixed}
  \x1b[90m– Skipped:\x1b[0m ${skipped}
  \x1b[33m○ Pending:\x1b[0m ${pending}

`)

  if (fixed > 0) {
    console.log('  \x1b[32mFixed tests:\x1b[0m')
    for (const test of tests.filter((t) => t.status === 'fixed')) {
      console.log(`    ✓ ${test.grep.slice(0, 70)}`)
    }
    console.log()
  }

  if (pending > 0) {
    console.log('  \x1b[33mStill pending:\x1b[0m')
    for (const test of tests.filter((t) => t.status === 'pending')) {
      console.log(`    ○ ${test.grep.slice(0, 70)}`)
    }
    console.log()
  }
}

// ============================================================================
// Test Execution
// ============================================================================

function runTest(test: FailingTest, opts: { headed: boolean }): number {
  // Determine the working directory from the file path
  const fileParts = test.file.split('/')
  let cwd = '.'
  if (fileParts[0] === 'apps' || fileParts[0] === 'packages') {
    cwd = fileParts.slice(0, 2).join('/')
  }

  // Build the relative file path for playwright
  const relativeFile = fileParts.slice(2).join('/')

  const args = ['playwright', 'test', relativeFile, '-g', `"${test.grep}"`]
  if (opts.headed) args.push('--headed')

  console.log(`\n  \x1b[2mRunning in ${cwd}:\x1b[0m`)
  console.log(`  \x1b[36mpnpm ${args.join(' ')}\x1b[0m\n`)
  console.log('  ─────────────────────────────────────────\n')

  try {
    execSync(`pnpm ${args.join(' ')}`, {
      cwd,
      stdio: 'inherit',
    })
    return 0
  } catch (e: any) {
    return e.status ?? 1
  }
}

function waitForKey(): Promise<string> {
  return new Promise((resolve) => {
    const onKeypress = (_str: string, key: { name?: string }) => {
      if (key?.name) {
        process.stdin.removeListener('keypress', onKeypress)
        resolve(key.name)
      }
    }
    process.stdin.on('keypress', onKeypress)
  })
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Load tests from JSONL
  const scriptDir = path.dirname(new URL(import.meta.url).pathname)
  const jsonlPath = path.join(scriptDir, 'failing-tests.jsonl')

  if (!fs.existsSync(jsonlPath)) {
    console.error(`\n  \x1b[31mError:\x1b[0m Could not find ${jsonlPath}`)
    console.error(`  Create a failing-tests.jsonl file with test definitions.\n`)
    process.exit(1)
  }

  const tests = loadTests(jsonlPath)

  if (tests.length === 0) {
    console.log(`\n  \x1b[32mNo failing tests!\x1b[0m Nothing to fix.\n`)
    process.exit(0)
  }

  // Setup readline for keypress events
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  readline.emitKeypressEvents(process.stdin, rl)

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  const cleanup = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    rl.close()
  }

  let currentIndex = 0
  render(tests, currentIndex)

  // Main event loop
  while (true) {
    const key = await waitForKey()

    // Handle Ctrl+C
    if (key === 'c') {
      renderSummary(tests)
      cleanup()
      process.exit(0)
    }

    switch (key) {
      case 'n':
      case 'return':
        currentIndex = Math.min(currentIndex + 1, tests.length - 1)
        render(tests, currentIndex)
        break

      case 'p':
        currentIndex = Math.max(currentIndex - 1, 0)
        render(tests, currentIndex)
        break

      case 'r':
      case 'R': {
        const headed = key === 'r'
        let running = true
        
        while (running) {
          const exitCode = runTest(tests[currentIndex]!, { headed })
          
          console.log(`\n  ─────────────────────────────────────────`)
          if (exitCode === 0) {
            console.log(`  \x1b[32mTest passed!\x1b[0m`)
          } else {
            console.log(`  \x1b[31mTest failed (exit code ${exitCode})\x1b[0m`)
          }
          console.log(`
  \x1b[2m[r] run again  [f] mark fixed  [s] skip  [b] back\x1b[0m
`)

          const action = await waitForKey()
          
          switch (action) {
            case 'r':
              // Loop continues
              break
            case 'f':
              tests[currentIndex]!.status = 'fixed'
              running = false
              // Auto-advance to next pending test
              const nextPendingAfterFix = tests.findIndex((t, i) => i > currentIndex && t.status === 'pending')
              if (nextPendingAfterFix !== -1) {
                currentIndex = nextPendingAfterFix
              }
              break
            case 's':
              tests[currentIndex]!.status = 'skipped'
              running = false
              // Auto-advance to next pending test
              const nextPendingAfterSkip = tests.findIndex((t, i) => i > currentIndex && t.status === 'pending')
              if (nextPendingAfterSkip !== -1) {
                currentIndex = nextPendingAfterSkip
              }
              break
            default:
              // Any other key goes back
              running = false
              break
          }
        }
        render(tests, currentIndex)
        break
      }

      case 'f':
        tests[currentIndex]!.status = 'fixed'
        // Auto-advance to next pending test
        const nextPending = tests.findIndex((t, i) => i > currentIndex && t.status === 'pending')
        if (nextPending !== -1) {
          currentIndex = nextPending
        } else {
          // Check if all done
          const allDone = tests.every((t) => t.status !== 'pending')
          if (allDone) {
            renderSummary(tests)
            console.log('  \x1b[32mAll tests addressed!\x1b[0m\n')
            cleanup()
            process.exit(0)
          }
        }
        render(tests, currentIndex)
        break

      case 's':
        tests[currentIndex]!.status = 'skipped'
        // Auto-advance to next pending test  
        const nextPendingSkip = tests.findIndex((t, i) => i > currentIndex && t.status === 'pending')
        if (nextPendingSkip !== -1) {
          currentIndex = nextPendingSkip
        }
        render(tests, currentIndex)
        break

      case 'l':
        renderList(tests, currentIndex)
        await waitForKey()
        render(tests, currentIndex)
        break

      case 'q':
        renderSummary(tests)
        cleanup()
        process.exit(0)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
