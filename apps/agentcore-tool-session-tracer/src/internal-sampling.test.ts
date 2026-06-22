// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRuntimeRequest, PROTOCOL_VERSION } from './protocol.ts'
import {
  readAgentCoreToolSampleConfig,
  sampleInsideAgentCore,
  selectInternalSampleModel,
} from './internal-sampling.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('AgentCore internal sampling configuration', () => {
  it('defaults to host mode and validates sample mode values', () => {
    expect(readAgentCoreToolSampleConfig({} as NodeJS.ProcessEnv)).toEqual({ mode: 'host' })
    expect(readAgentCoreToolSampleConfig({ AGENTCORE_TOOL_SAMPLE_MODE: 'internal' } as NodeJS.ProcessEnv)).toEqual({ mode: 'internal' })
    expect(() => readAgentCoreToolSampleConfig({ AGENTCORE_TOOL_SAMPLE_MODE: 'bogus' } as NodeJS.ProcessEnv)).toThrow('AGENTCORE_TOOL_SAMPLE_MODE')
  })

  it('requires explicit internal sample provider and id together', () => {
    expect(() => readAgentCoreToolSampleConfig({
      AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER: 'amazon-bedrock',
    } as NodeJS.ProcessEnv)).toThrow('must be set together')
    expect(readAgentCoreToolSampleConfig({
      AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER: 'amazon-bedrock',
      AGENTCORE_TOOL_SAMPLE_MODEL_ID: 'zai.glm-5',
    } as NodeJS.ProcessEnv)).toEqual({
      mode: 'host',
      explicitModel: { provider: 'amazon-bedrock', id: 'zai.glm-5' },
    })
  })

  it('selects explicit sample model before inherited model', () => {
    expect(selectInternalSampleModel({
      mode: 'internal',
      explicitModel: { provider: 'amazon-bedrock', id: 'zai.glm-5' },
    }, { provider: 'ollama', id: 'qwen3:30b' })).toEqual({ provider: 'amazon-bedrock', id: 'zai.glm-5' })

    expect(selectInternalSampleModel({ mode: 'internal' }, { provider: 'amazon-bedrock', id: 'zai.glm-5' })).toEqual({ provider: 'amazon-bedrock', id: 'zai.glm-5' })
    expect(() => selectInternalSampleModel({ mode: 'internal' }, undefined)).toThrow('context.model')
  })

  it('rejects inherited local-only Ollama without host fallback', async () => {
    vi.stubEnv('AGENTCORE_TOOL_SAMPLE_MODE', 'internal')
    await expect(sampleInsideAgentCore({
      inheritedModel: { provider: 'ollama', id: 'qwen3:30b' },
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toThrow('AGENTCORE_TOOL_SAMPLE_MODE=host')
  })

  it('accepts structured context.model in start_tool_session protocol', () => {
    expect(parseRuntimeRequest({
      op: 'start_tool_session',
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'cmd',
      toolSessionId: 'ts',
      toolName: 'simple_result',
      context: { model: { provider: 'amazon-bedrock', id: 'zai.glm-5' } },
    })).toMatchObject({ context: { model: { provider: 'amazon-bedrock', id: 'zai.glm-5' } } })

    expect(() => parseRuntimeRequest({
      op: 'start_tool_session',
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'cmd',
      toolSessionId: 'ts',
      toolName: 'simple_result',
      context: { model: { provider: '', id: 'zai.glm-5' } },
    })).toThrow()
  })
})
