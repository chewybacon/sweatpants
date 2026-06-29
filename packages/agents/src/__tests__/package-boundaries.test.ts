import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const agentsRoot = resolve(process.cwd())

describe('@sweatpants/agents package boundaries', () => {
  it('publicly re-exports canonical core tool authoring APIs', () => {
    const index = readFileSync(resolve(agentsRoot, 'src/index.ts'), 'utf8')

    expect(index).toContain("createTool")
    expect(index).toContain("from '@sweatpants/core'")
    expect(index).toContain('type ToolDefinition')
  })

  it('does not keep duplicate agents tool builders', () => {
    expect(existsSync(resolve(agentsRoot, 'src/create-tool.ts'))).toBe(false)
    expect(existsSync(resolve(agentsRoot, 'src/create-tool2.ts'))).toBe(false)
  })

  it('does not publicly export removed tool builder names', () => {
    const index = readFileSync(resolve(agentsRoot, 'src/index.ts'), 'utf8')

    expect(index).not.toContain(['create', 'Tool2'].join(''))
    expect(index).not.toContain('finalizeUnifiedTool')
    expect(index).not.toContain('normalizeElicits')
  })
})
