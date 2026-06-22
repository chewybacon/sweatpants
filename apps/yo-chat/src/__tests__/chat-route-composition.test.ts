import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appRoot = process.cwd()

function read(relativePath: string): string {
  return readFileSync(resolve(appRoot, relativePath), 'utf8')
}

function listFiles(dir: string): string[] {
  const root = resolve(appRoot, dir)
  return readdirSync(root).flatMap((entry) => {
    const full = resolve(root, entry)
    const rel = `${dir}/${entry}`
    return statSync(full).isDirectory() ? listFiles(rel) : [rel]
  })
}

describe('yo-chat chat application composition', () => {
  it('keeps the api.chat route as thin route glue', () => {
    const route = read('src/routes/api.chat.ts')

    expect(route).toContain("from '../server/chat-application'")
    expect(route).toContain('chatApp.handle(request)')
    expect(route).toContain('withDefaultSystemPrompt(request)')
    expect(route.split('\n').length).toBeLessThanOrEqual(30)

    for (const forbidden of [
      '@sweatpants/model-provider-pi-ai',
      '@sweatpants/tool-runtime-local',
      '@sweatpants/tool-runtime-agentcore',
      '@sweatpants/framework/chat/durable-streams',
      'createToolInventory',
      'installAgentCoreToolRuntime',
      'installLocalToolRuntime',
      'createPluginSessionManager',
    ]) {
      expect(route).not.toContain(forbidden)
    }
  })

  it('keeps production chat wiring in app-owned server modules', () => {
    const serverFiles = listFiles('src/server')
    expect(serverFiles).toContain('src/server/chat-application.ts')

    expect(serverFiles).toEqual(expect.arrayContaining([
      'src/server/default-system-prompt.ts',
      'src/server/durable-streams.ts',
      'src/server/model-provider.ts',
      'src/server/plugin-sampling-provider.ts',
      'src/server/tool-runtime.ts',
      'src/server/tools.ts',
    ]))

    const composition = read('src/server/chat-application.ts')
    expect(composition).toContain('createYoChatApplication')
    expect(composition).toContain('createChatApplication')
    expect(composition).toContain('createChatHandler')
    expect(composition.split('\n').length).toBeLessThanOrEqual(60)

    const serverSources = serverFiles.map((file) => read(file)).join('\n')
    expect(serverSources).toContain('installPiAiModelProvider')
    expect(serverSources).toContain('installLocalToolRuntime')
    expect(serverSources).toContain('installAgentCoreToolRuntime')
    expect(serverSources).toContain('withDefaultSystemPrompt')
  })
})
