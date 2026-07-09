#!/usr/bin/env tsx
/**
 * Grep gates for unified-tool-types (REQ-026/027).
 * Fails non-zero if banned patterns appear outside allowlisted paths.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

type Gate = {
  name: string
  pattern: string
  paths: string[]
  /** Paths/files to exclude from matches (substring match on file path) */
  exclude?: string[]
}

const gates: Gate[] = [
  {
    name: 'deleted-result-types',
    pattern: 'CoreElicitResult|RawElicitResult|RawSampleResult\\b',
    paths: ['packages', 'apps'],
    // temporary re-export aliases during migration still present in framework
    exclude: [
      'mcp-tool-types.ts',
      'index.ts', // re-exports
      'dist/',
      'node_modules/',
      'docs/',
      'archive/',
      'unified-tool-types',
      // Temporary Raw* aliases still imported during migration
      'packages/framework/',
      'packages/tool-runtime-local/',
      'packages/tool-runtime-agentcore/',
    ],
  },
  {
    name: 'dialect-shims',
    pattern: 'legacyContextData|spreadContext',
    paths: ['packages', 'apps'],
    exclude: ['dist/', 'node_modules/', 'docs/', 'unified-tool-types'],
  },
  {
    name: 'as-never-welds',
    pattern: 'as never',
    paths: [
      'packages/core/src/tool',
      'packages/core/src/builtins',
      'packages/framework/src/lib/chat/mcp-tools',
      'packages/tool-runtime-local/src',
      'packages/tool-runtime-agentcore/src',
      'apps/yo-chat/src/server',
    ],
    exclude: [
      'dist/',
      'node_modules/',
      '__tests__',
      'docs/',
      // Temporary residual dual-path execute support in mock-runtime / bridge until McpRuntimeTool.execute is fully deleted
      'mock-runtime.ts',
      'bridge-runtime.ts',
    ],
  },
  {
    name: 'call-site-casts',
    pattern: 'as LocalSessionTool|as AgentCoreMcpTool|as ElicitResult\\b',
    paths: ['apps', 'packages'],
    exclude: ['dist/', 'node_modules/', 'docs/', 'unified-tool-types'],
  },
  {
    name: 'inline-type-imports',
    // Inline `import("@sweatpants/...")` type references hide dependencies and
    // resolve outside the module graph — use top-level `import type` instead.
    pattern: 'import\\("@sweatpants',
    paths: [
      'packages/core/src',
      'packages/framework/src',
      'packages/tool-runtime-local/src',
      'packages/tool-runtime-agentcore/src',
      'packages/elicit-context/src',
      'apps/yo-chat/src',
      'apps/yo-mcp/src',
    ],
    exclude: ['dist/', 'node_modules/', '__tests__', '.test.ts'],
  },
  {
    name: 'mcp-runtime-dual-dispatch',
    pattern: 'isCanonicalCoreRuntimeTool',
    paths: ['packages', 'apps'],
    exclude: ['dist/', 'node_modules/', 'docs/', 'unified-tool-types'],
  },
]

function runGate(gate: Gate): string[] {
  const pathArgs = gate.paths.filter((p) => existsSync(p)).join(' ')
  if (!pathArgs) return []
  try {
    const out = execSync(
      `rg -n --glob '!**/dist/**' --glob '!**/node_modules/**' -e '${gate.pattern}' ${pathArgs} || true`,
      { encoding: 'utf8', shell: '/bin/bash' },
    )
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((line) => !(gate.exclude ?? []).some((ex) => line.includes(ex)))
  } catch {
    return []
  }
}

let failed = 0
for (const gate of gates) {
  const hits = runGate(gate)
  if (hits.length) {
    failed++
    console.error(`\n[FAIL] gate ${gate.name} (${hits.length} hits):`)
    for (const h of hits.slice(0, 30)) console.error('  ' + h)
    if (hits.length > 30) console.error(`  ... +${hits.length - 30} more`)
  } else {
    console.log(`[ok] ${gate.name}`)
  }
}

if (failed) {
  console.error(`\n${failed} gate(s) failed`)
  process.exit(1)
}
console.log('\nAll banned-symbol gates passed')
