import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const frameworkRoot = resolve(process.cwd())

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('framework package boundaries', () => {
  it('exports only scope-driven framework subpaths', () => {
    const pkg = readJson(resolve(frameworkRoot, 'package.json')) as { exports: Record<string, unknown> }
    expect(Object.keys(pkg.exports).sort()).toEqual([
      '.',
      './chat',
      './chat/core-tools',
      './chat/durable-streams',
      './chat/isomorphic-tools',
      './chat/mcp-tools',
      './server',
    ])
  })

  it('does not declare concrete adapter/UI/runtime production dependencies', () => {
    const pkg = readJson(resolve(frameworkRoot, 'package.json')) as { dependencies?: Record<string, string> }
    const dependencies = Object.keys(pkg.dependencies ?? {})
    expect(dependencies).not.toContain('@earendil-works/pi-ai')
    expect(dependencies).not.toContain('@aws-sdk/client-bedrock-agentcore')
    expect(dependencies).not.toContain('@sweatpants/model-provider-pi-ai')
    expect(dependencies).not.toContain('@sweatpants/tool-runtime-local')
    expect(dependencies).not.toContain('@sweatpants/tool-runtime-agentcore')
    expect(dependencies).not.toContain('react')
    expect(dependencies).not.toContain('vite')
  })

  it('does not publicly export removed provider/runtime/react compatibility names', () => {
    const chatIndex = readFileSync(resolve(frameworkRoot, 'src/lib/chat/index.ts'), 'utf8')
    expect(chatIndex).not.toContain('ProviderContext')
    expect(chatIndex).not.toContain('RuntimeContext')
    expect(chatIndex).not.toContain('RuntimeModelContext')
    expect(chatIndex).not.toContain('RuntimeStreamConfigContext')
    expect(chatIndex).not.toContain('ChatProvider')
  })

  it('does not keep legacy provider/runtime or local tool runtime implementation files in framework', () => {
    for (const file of [
      'src/lib/chat/providers/types.ts',
      'src/lib/chat/providers/contexts.ts',
      'src/lib/chat/providers/config.ts',
      'src/lib/chat/runtime/contexts.ts',
      'src/handler/index.ts',
      'src/lib/chat/mcp-tools/session/in-memory-store.ts',
      'src/lib/chat/mcp-tools/session/session-registry.ts',
      'src/lib/chat/mcp-tools/session/setup.ts',
      'src/lib/chat/mcp-tools/session/tool-session.ts',
      'src/lib/chat/mcp-tools/session/worker-tool-session.ts',
      'src/lib/chat/mcp-tools/session/worker-runner.ts',
      'src/lib/chat/mcp-tools/session/worker-session-api.ts',
      'src/lib/chat/mcp-tools/session/worker-types.ts',
    ]) {
      expect(existsSync(resolve(frameworkRoot, file)), file).toBe(false)
    }
  })
})
