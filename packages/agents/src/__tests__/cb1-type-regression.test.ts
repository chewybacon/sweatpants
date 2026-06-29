import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { createAgent } from '../create-agent.ts'
import type { ToolTarget, TargetInput, TargetOutput } from '../types.ts'

const nativeTool = createTool('native_x')
  .description('d')
  .parameters(z.object({ b: z.number() }))
  .output(z.object({ result: z.string() }))
  .execute(function* (input, ctx) {
    yield* ctx.notify('hi')
    return { result: String(input.b) }
  })

const _nativeOk: ToolTarget = nativeTool
void _nativeOk

type NativeIn = TargetInput<typeof nativeTool>
type NativeOut = TargetOutput<typeof nativeTool>
const _nativeIn: NativeIn = { b: 1 }
const _nativeOut: NativeOut = { result: '1' }
void _nativeIn
void _nativeOut

const Agent = createAgent({
  name: 'typed',
  description: 'd',
  systemPrompt: 's',
  tools: { native: nativeTool },
  entry: function* (_input: string, ctx) {
    const r = yield* ctx.tools.native({ b: 42 })
    return { r }
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

void (undefined as unknown as typeof Agent)

describe('CB-1 type regression (canonical core tools are ToolTarget, no as never)', () => {
  it('compiles (type-level guard)', () => {
    expect(true).toBe(true)
  })
})
