import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const generatedPath = 'apps/yo-chat/src/__generated__'

function run(command: string, args: string[], options: { cwd: string; inherit?: boolean }) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
  })

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}${
        result.stderr ? `\n${result.stderr}` : ''
      }`,
    )
  }

  return result.stdout ?? ''
}

function snapshot(): string {
  const status = run('git', ['status', '--short', '--', generatedPath], { cwd: repoRoot })
  const diff = run('git', ['diff', '--binary', '--', generatedPath], { cwd: repoRoot })
  return `${status}\n---DIFF---\n${diff}`
}

const before = snapshot()
run('pnpm', ['exec', 'tsx', 'scripts/generate-tools.ts'], { cwd: appRoot, inherit: true })
const after = snapshot()

if (before !== after) {
  console.error('\nGenerated yo-chat tool files are stale. Run:')
  console.error('  pnpm -C apps/yo-chat generate:tools')
  console.error('\nThen review and commit the changes under:')
  console.error(`  ${generatedPath}`)
  process.exit(1)
}

console.log('yo-chat generated tool files are up to date')
