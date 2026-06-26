/**
 * Native unified tool builder (REQ-005/006).
 *
 * This is the core builder shape for new Sweatpants tools:
 * `createTool(name).description(...).parameters(...).elicits(...).requires(...).execute(...)`.
 * It produces a `UnifiedToolFactory` directly, so agents can call it without an
 * adapter and build tool-call exchanges around the invocation.
 */

import type { Operation } from 'effection'
import type { z } from 'zod'

import type {
  ElicitDefinition,
  ElicitsMap,
  NormalizedElicitDefinition,
  NormalizedElicitsMap,
  ToolCtx,
  UnifiedToolFactory,
} from './tool-ctx.ts'

export interface ToolCapabilities {
  elicitation?: boolean
  sampling?: boolean
}

export interface CreateToolBuilderBase<TName extends string> {
  readonly _name: TName
  description(desc: string): CreateToolBuilderWithDescription<TName>
}

export interface CreateToolBuilderWithDescription<TName extends string> {
  readonly _name: TName
  readonly _description: string
  parameters<TSchema extends z.ZodType>(
    schema: TSchema,
  ): CreateToolBuilderWithParams<TName, z.infer<TSchema>>
}

export interface CreateToolBuilderWithParams<TName extends string, TInput> {
  readonly _name: TName
  readonly _description: string
  readonly _parameters: z.ZodType<TInput>
  elicits<TElicits extends ElicitsMap>(
    elicits: TElicits,
  ): CreateToolBuilderWithElicits<TName, TInput, TElicits>
}

export interface CreateToolBuilderWithElicits<
  TName extends string,
  TInput,
  TElicits extends ElicitsMap,
> {
  readonly _name: TName
  readonly _description: string
  readonly _parameters: z.ZodType<TInput>
  readonly _elicits: TElicits
  requires(caps: ToolCapabilities): CreateToolBuilderWithElicits<TName, TInput, TElicits>
  execute<TResult>(
    fn: (input: TInput, ctx: ToolCtx<TElicits>) => Operation<TResult>,
  ): UnifiedToolFactory<TInput, TResult, TElicits>
  handoff<THandoff, TClient, TResult>(config: {
    before?: (input: TInput, ctx: HandoffServerCtx) => Operation<THandoff>
    client: (handoff: THandoff, ctx: ToolCtx<TElicits>, input: TInput) => Operation<TClient>
    after: (
      handoff: THandoff,
      client: TClient,
      ctx: HandoffServerCtx,
      input: TInput,
    ) => Operation<TResult>
  }): UnifiedToolFactory<TInput, TResult, TElicits>
}

export interface HandoffServerCtx {
  callId: string
  signal: AbortSignal
}

interface BuilderState {
  name: string
  description?: string
  parameters?: z.ZodType
  elicits?: ElicitsMap
  capabilities?: ToolCapabilities
}

export function createTool<TName extends string>(
  name: TName,
): CreateToolBuilderBase<TName> {
  return createBuilder({ name }) as CreateToolBuilderBase<TName>
}

function createBuilder(state: BuilderState): unknown {
  return {
    _name: state.name,
    _description: state.description,
    _parameters: state.parameters,
    _elicits: state.elicits,

    description(desc: string) {
      return createBuilder({ ...state, description: desc })
    },

    parameters(schema: z.ZodType) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .parameters()`)
      }
      return createBuilder({ ...state, parameters: schema })
    },

    elicits(elicits: ElicitsMap) {
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .elicits()`)
      }
      // Normalize now so finalization errors happen close to authoring.
      normalizeElicits(elicits)
      return createBuilder({ ...state, elicits })
    },

    requires(caps: ToolCapabilities) {
      if (!state.elicits) {
        throw new Error(`Tool "${state.name}": .elicits() must be called before .requires()`)
      }
      return createBuilder({ ...state, capabilities: caps })
    },

    execute(fn: (input: unknown, ctx: ToolCtx) => Operation<unknown>) {
      assertReady(state, '.execute()')
      return finalizeUnifiedTool({
        name: state.name,
        description: state.description!,
        parameters: state.parameters!,
        elicits: state.elicits!,
        capabilities: state.capabilities,
        impl: fn,
      })
    },

    handoff(config: {
      before?: (input: unknown, ctx: HandoffServerCtx) => Operation<unknown>
      client: (handoff: unknown, ctx: ToolCtx, input: unknown) => Operation<unknown>
      after: (
        handoff: unknown,
        client: unknown,
        ctx: HandoffServerCtx,
        input: unknown,
      ) => Operation<unknown>
    }) {
      assertReady(state, '.handoff()')
      const impl = function* (input: unknown, ctx: ToolCtx): Operation<unknown> {
        const serverCtx: HandoffServerCtx = {
          callId: `handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          signal: new AbortController().signal,
        }
        const handoff = config.before ? yield* config.before(input, serverCtx) : input
        const clientResult = yield* config.client(handoff, ctx, input)
        return yield* config.after(handoff, clientResult, serverCtx, input)
      }
      const tool = finalizeUnifiedTool({
        name: state.name,
        description: state.description!,
        parameters: state.parameters!,
        elicits: state.elicits!,
        capabilities: state.capabilities ?? { elicitation: true, sampling: true },
        impl,
      }) as UnifiedToolFactory
      Object.defineProperty(tool, 'handoffConfig', {
        value: config,
        enumerable: true,
        configurable: true,
      })
      return tool
    },
  }
}

function assertReady(state: BuilderState, terminal: string): void {
  if (!state.description) {
    throw new Error(`Tool "${state.name}": .description() must be called before ${terminal}`)
  }
  if (!state.parameters) {
    throw new Error(`Tool "${state.name}": .parameters() must be called before ${terminal}`)
  }
  if (!state.elicits) {
    throw new Error(
      `Tool "${state.name}": .elicits() must be called before ${terminal}. Use .elicits({}) if no elicitation is needed.`,
    )
  }
}

export interface FinalizeUnifiedToolOptions<I = unknown, O = unknown, TElicits extends ElicitsMap = ElicitsMap> {
  name: string
  description: string
  parameters: z.ZodType<I> | { safeParse: (input: unknown) => { success: boolean; data?: I; error?: { message?: string } } }
  output?: unknown | undefined
  elicits?: TElicits | undefined
  normalizedElicits?: NormalizedElicitsMap | undefined
  capabilities?: ToolCapabilities | undefined
  impl: (input: I, ctx: ToolCtx<TElicits>) => Operation<O>
}

export function finalizeUnifiedTool<I, O, TElicits extends ElicitsMap = ElicitsMap>(
  options: FinalizeUnifiedToolOptions<I, O, TElicits>,
): UnifiedToolFactory<I, O, TElicits> {
  const normalized = options.normalizedElicits ?? normalizeElicits(options.elicits ?? ({} as TElicits))

  const factory = function unifiedToolFactory(
    ctx: ToolCtx<TElicits>,
  ): Operation<(input: I) => Operation<O>> {
    return {
      *[Symbol.iterator]() {
        const invoke = (input: I): Operation<O> =>
          (function* (): Operation<O> {
            const parsed = options.parameters.safeParse(input)
            if (!parsed.success || parsed.data === undefined) {
              throw codedError(
                'invalid_tool_input',
                `Invalid input for tool "${options.name}": ${parsed.error?.message ?? 'validation failed'}`,
              )
            }
            return yield* options.impl(parsed.data as I, ctx)
          })()
        return invoke
      },
    }
  }

  Object.defineProperties(factory, {
    name: { value: options.name, enumerable: true, writable: false, configurable: true },
    description: { value: options.description, enumerable: true, writable: false, configurable: true },
    parameters: { value: options.parameters, enumerable: true, writable: false, configurable: true },
    elicits: { value: normalized, enumerable: true, writable: false, configurable: true },
    schemas: {
      value: { input: options.parameters, output: options.output },
      enumerable: true,
      writable: false,
      configurable: true,
    },
    capabilities: {
      value: options.capabilities ?? { elicitation: Object.keys(normalized).length > 0, sampling: false },
      enumerable: true,
      writable: false,
      configurable: true,
    },
    requires: {
      value: options.capabilities,
      enumerable: true,
      writable: false,
      configurable: true,
    },
  })

  return factory as unknown as UnifiedToolFactory<I, O, TElicits>
}

export function normalizeElicits<TElicits extends ElicitsMap>(
  elicits: TElicits,
): NormalizedElicitsMap {
  const normalized: NormalizedElicitsMap = {}
  for (const [key, entry] of Object.entries(elicits)) {
    const def = isElicitDefinitionLike(entry)
      ? ({ ...(entry as ElicitDefinition) } as NormalizedElicitDefinition)
      : ({ response: entry } as NormalizedElicitDefinition)

    def.mode = def.mode ?? 'form'

    if (def.mode === 'form' && def.response === undefined) {
      throw codedError(
        'invalid_elicit_definition',
        `Elicit "${key}" uses form mode but has no response schema`,
      )
    }
    if (def.ttlMs !== undefined && (!Number.isFinite(def.ttlMs) || def.ttlMs < 0)) {
      throw codedError('invalid_interrupt_expiry', `Elicit "${key}" has invalid ttlMs`)
    }

    normalized[key] = def
  }
  return normalized
}

function isElicitDefinitionLike(value: unknown): value is ElicitDefinition {
  if (!value || typeof value !== 'object') return false
  if (typeof (value as { safeParse?: unknown }).safeParse === 'function') return false
  return (
    'response' in value ||
    'context' in value ||
    'reason' in value ||
    'ttlMs' in value ||
    'metadata' in value ||
    'mode' in value
  )
}

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}
