import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(process.cwd())

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      return listSourceFiles(full)
    }
    return full.endsWith('.ts') ? [full] : []
  })
}

describe('@sweatpants/session-contract package boundaries', () => {
  it('ships authoring contract documentation with rules and tier/fate tables', () => {
    const docs = readFileSync(resolve(packageRoot, 'docs/authoring-contract.md'), 'utf8')
    expect(docs).toContain('Four portable rules')
    expect(docs).toContain('Durability tiers')
    expect(docs).toContain('Fate × mode table')
    expect(docs).toContain('Resolution variance is excluded from effect identity')
  })

  it('preserves legacy-agent salvage while deleting runtime legacy agent directories', () => {
    const repoRoot = resolve(packageRoot, '../..')
    expect(existsSync(resolve(repoRoot, 'packages/agents'))).toBe(false)
    expect(existsSync(resolve(repoRoot, 'packages/core/src/agent'))).toBe(false)

    const salvage = readFileSync(resolve(packageRoot, 'docs/legacy-agent-salvage.md'), 'utf8')
    expect(salvage).toContain('legacy-projections.reference.ts')
    expect(salvage).toContain('legacy-commands.reference.ts')
    expect(existsSync(resolve(packageRoot, 'docs/salvage/legacy-projections.reference.ts'))).toBe(true)
    expect(existsSync(resolve(packageRoot, 'docs/salvage/legacy-commands.reference.ts'))).toBe(true)
    expect(existsSync(resolve(packageRoot, 'docs/salvage/core-agent-create.reference.ts'))).toBe(true)
    expect(existsSync(resolve(packageRoot, 'docs/salvage/core-agent-types.reference.ts'))).toBe(true)
  })

  it('stays a leaf package with no workspace runtime dependencies', () => {
    const pkg = readJson(resolve(packageRoot, 'package.json')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    const prodDependencies = Object.keys(pkg.dependencies ?? {})
    expect(prodDependencies).not.toContain('@sweatpants/framework')
    expect(prodDependencies).not.toContain('@sweatpants/tool-runtime-local')
    expect(prodDependencies).not.toContain('@sweatpants/tool-runtime-agentcore')
    expect(prodDependencies).not.toContain('@sweatpants/core')

    const devDependencies = Object.keys(pkg.devDependencies ?? {})
    expect(devDependencies).not.toContain('@sweatpants/framework')
    expect(devDependencies).not.toContain('@sweatpants/tool-runtime-local')
    expect(devDependencies).not.toContain('@sweatpants/tool-runtime-agentcore')
  })

  it('does not import framework or runtime packages from production source', () => {
    const forbidden = [
      '@sweatpants/framework',
      '@sweatpants/tool-runtime-local',
      '@sweatpants/tool-runtime-agentcore',
      '@sweatpants/core',
    ]

    const productionFiles = listSourceFiles(resolve(packageRoot, 'src')).filter(
      (file) => !file.includes('__tests__'),
    )

    for (const file of productionFiles) {
      const source = readFileSync(file, 'utf8')
      for (const specifier of forbidden) {
        expect(source, `${file} must not import ${specifier}`).not.toContain(`from '${specifier}'`)
        expect(source, `${file} must not import ${specifier}`).not.toContain(`from \"${specifier}\"`)
      }
    }
  })

  // NFR-014 / REQ-060: session-contract may import only from
  // @sweatpants/durable-streams/types and /in-memory-store. The root export
  // and /redis subpath are forbidden (redis must not enter the install graph).
  it('imports only /types and /in-memory-store from durable-streams, not root or /redis', () => {
    const productionFiles = listSourceFiles(resolve(packageRoot, 'src')).filter(
      (file) => !file.includes('__tests__'),
    )

    for (const file of productionFiles) {
      const source = readFileSync(file, 'utf8')
      // Any import from @sweatpants/durable-streams must be a subpath
      const imports = source.match(/from\s+['\"]@sweatpants\/durable-streams[^'\"]*['\"]/g) ?? []
      for (const match of imports) {
        const specifier = match.match(/@sweatpants\/durable-streams[^'\"]*/)?.[0]
        expect(specifier, `${file} import specifier should be parseable`).toBeDefined()
        // Allowed: /types and /in-memory-store
        // Forbidden: bare root and /redis
        expect(
          specifier === '@sweatpants/durable-streams' || specifier === '@sweatpants/durable-streams/redis',
          `${file} must not import ${specifier} (only /types and /in-memory-store are allowed)`,
        ).toBe(false)
      }
    }
  })
})
