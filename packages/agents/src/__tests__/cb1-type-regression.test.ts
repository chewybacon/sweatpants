/**
 * CB-1 regression: unified tools are assignable to `ToolTarget` WITHOUT `as
 * never` casts, and `ctx.tools.X(input)` infers the correct input/output types.
 *
 * This is a type-level test. It runs under vitest (no runtime assertions) but
 * the real guard is that it compiles: if `UnifiedToolFactory` regresses to not
 * being assignable to `ToolTarget`, or the sugar erases to `never`, the
 * `const _ok: ToolTarget = tool` / `ctx.tools.X(input)` lines below fail to
 * typecheck.
 *
 * NOTE: the package tsconfig excludes `__tests__/` from `tsc -b`, so this file
 * is not checked by `pnpm check`. It IS checked when the agents package is
 * type-checked with tests included (e.g. via a typecheck tsconfig or `vitest
 * --typecheck`). The authoritative runtime proof is the E2E suites; this file
 * documents and guards the type-level contract.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createMCPTool } from '../../../framework/src/lib/chat/mcp-tools/builder.ts'
import { createTool } from '@sweatpants/core'
import { createAgent } from '../create-agent.ts'
import type { ToolTarget, TargetInput, TargetOutput } from '../types.ts'

// --- createMCPTool output is a ToolTarget (no `as never`) ---

const mcpTool = createMCPTool('mcp_x')
  .description('d')
  .parameters(z.object({ a: z.string() }))
  .execute(function* () {
    return { ok: true }
  })

const _mcpOk: ToolTarget = mcpTool
void _mcpOk

// --- canonical core createTool output is a ToolTarget (no `as never`) ---

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

// --- TargetInput / TargetOutput extract correctly from either shape ---

type MCPIn = TargetInput<typeof mcpTool>
type MCPOut = TargetOutput<typeof mcpTool>
const _mcpIn: MCPIn = { a: 'x' }
const _mcpOut: MCPOut = { ok: true }
void _mcpIn
void _mcpOut

type NativeIn = TargetInput<typeof nativeTool>
type NativeOut = TargetOutput<typeof nativeTool>
const _nativeIn: NativeIn = { b: 1 }
const _nativeOut: NativeOut = { result: '1' }
void _nativeIn
void _nativeOut

// --- ctx.tools.X(input) infers correctly (no `never`) ---

const Agent = createAgent({
  name: 'typed',
  description: 'd',
  systemPrompt: 's',
  tools: { mcp: mcpTool, native: nativeTool },
  entry: function* (_input: string, ctx) {
    // These calls typecheck only because ctx.tools.mcp / ctx.tools.native
    // carry their real input/output types (CB-1: previously erased to `never`).
    const r1 = yield* ctx.tools.mcp({ a: 'hello' })
    const r2 = yield* ctx.tools.native({ b: 42 })
    return { r1, r2 }
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

void (undefined as unknown as typeof Agent)

describe('CB-1 type regression (unified tools are ToolTarget, no as never)', () => {
  it('compiles (type-level guard)', () => {
    // Runtime no-op; the guard is compilation itself.
    expect(true).toBe(true)
  })
})
