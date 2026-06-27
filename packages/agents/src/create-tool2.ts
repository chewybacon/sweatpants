/**
 * createTool2 — migration wrapper around the native unified tool builder.
 *
 * New code should prefer `createTool(name).description(...).parameters(...).elicits(...).execute(...)`.
 * This config-style helper remains for existing tests/call-sites and emits the
 * same `UnifiedToolFactory` shape.
 */

import type { Operation } from 'effection'
import type { z, ZodSchema } from 'zod'

import type { ElicitsMap, ToolCtx, UnifiedToolFactory } from './tool-ctx.ts'
import { finalizeUnifiedTool, normalizeElicits, type ToolCapabilities } from './create-tool.ts'

export interface UnifiedToolConfig<
  TInput extends ZodSchema,
  TOutput extends ZodSchema,
  TElicits extends ElicitsMap = {},
> {
  name: string
  description: string
  input: TInput
  output: TOutput
  /** Optional declared elicit map; omit only for tools that exclusively use ctx.elicitDynamic(...). */
  elicits?: TElicits
  /** Capabilities required of the client (MCP `requires`, REQ-005). */
  capabilities?: ToolCapabilities
  impl: (input: z.infer<TInput>, ctx: ToolCtx<TElicits>) => Operation<z.infer<TOutput>>
}

export function createTool2<
  TInput extends ZodSchema,
  TOutput extends ZodSchema,
  TElicits extends ElicitsMap = {},
>(
  config: UnifiedToolConfig<TInput, TOutput, TElicits>,
): UnifiedToolFactory<z.infer<TInput>, z.infer<TOutput>, TElicits> {
  const elicits = (config.elicits ?? ({} as TElicits)) as TElicits
  return finalizeUnifiedTool({
    name: config.name,
    description: config.description,
    parameters: config.input,
    output: config.output,
    elicits,
    normalizedElicits: normalizeElicits(elicits),
    capabilities: config.capabilities,
    impl: config.impl,
  })
}
