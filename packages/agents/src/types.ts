/**
 * Agent type definitions — the unified agent model.
 *
 * An agent is a callable coroutine (Spec REQ-001): a definition produced by
 * `createAgent` comprising an `entry` harness, `tools`, optional `subAgents`,
 * `model`, and config. It composes in-process as a generator call and deploys
 * over a protocol handler with no changes (isomorphic fulfillment, DD2).
 */

import type { Operation } from 'effection'

import type {
  AnyToolFactory,
  InputFromFactory,
  OutputFromFactory,
  ToolMiddleware,
} from '@sweatpants/core'

import type { AgentCtx, AgentInstance } from './ctx.ts'
import type { UnifiedToolFactory } from './tool-ctx.ts'

// ============================================================================
// Tool target — core ToolFactory OR UnifiedToolFactory (design DD5/REQ-3/REQ-4)
// ============================================================================

/**
 * A tool that can be registered on an agent and invoked via `ctx.tools.X` /
 * `ctx.call`. Either a core `AnyToolFactory` (zero-arg activation, `(args, send)`
 * impl) or a `UnifiedToolFactory` (activated with a `ToolCtx`, `(input, ctx)`
 * impl). The runtime detects which via `isUnifiedToolFactory`.
 */
export type ToolTarget = AnyToolFactory | UnifiedToolFactory<any, any>

/** Extract the input type from either factory shape. */
export type TargetInput<T> = T extends UnifiedToolFactory<infer I, any>
  ? I
  : T extends AnyToolFactory
    ? InputFromFactory<T>
    : never

/** Extract the output type from either factory shape. */
export type TargetOutput<T> = T extends UnifiedToolFactory<any, infer O>
  ? O
  : T extends AnyToolFactory
    ? OutputFromFactory<T>
    : never

export interface ModelSelection {
  provider: string
  id: string
}

// ============================================================================
// Input/output extraction for agents
// ============================================================================

/** Extract the input type of an AgentFactory (the entry's first arg). */
export type AgentInput<F extends AgentFactory<any, any, any, any>> =
  F extends AgentFactory<infer I, any, any, any> ? I : never

/** Extract the output type of an AgentFactory (the entry's return). */
export type AgentOutput<F extends AgentFactory<any, any, any, any>> =
  F extends AgentFactory<any, infer O, any, any> ? O : never

// ============================================================================
// Agent middleware (agent-level, around the entry invocation)
// ============================================================================

/**
 * Middleware around the agent's `entry` invocation — same shape as
 * `ToolMiddleware`. Composed via `createApi`'s `around` (see create-agent.ts).
 */
export type AgentMiddleware<I, O> = (
  input: I,
  next: (input: I) => Operation<O>,
) => Operation<O>

// ============================================================================
// Agent config
// ============================================================================

export interface AgentConfig<
  I,
  O,
  TTools extends Record<string, ToolTarget>,
  TSub extends Record<string, AgentFactory<any, any, any, any>> | undefined,
> {
  name: string
  description: string
  systemPrompt: string
  tools: TTools
  /** Imported agent definitions (Spec REQ-004/006: imports, not services). */
  subAgents?: TSub
  /** The harness: the agent's reasoning loop (Spec REQ-009). */
  entry: (input: I, ctx: AgentCtx<TTools, TSub>) => Operation<O>
  model: ModelSelection
  maxIterations: number
  /** Optional goal incorporated into the harness system-prompt framing. */
  goal?: string
}

// ============================================================================
// Agent factory (what createAgent returns)
// ============================================================================

export interface AgentFactory<
  I = unknown,
  O = unknown,
  TTools extends Record<string, ToolTarget> = Record<string, ToolTarget>,
  TSub extends
    | Record<string, AgentFactory<any, any, any, any>>
    | undefined = undefined,
> {
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly tools: TTools
  readonly subAgents?: TSub
  readonly model: ModelSelection
  readonly maxIterations: number
  readonly goal?: string
  readonly entry: (input: I, ctx: AgentCtx<TTools, TSub>) => Operation<O>
  /** Activate the agent in the current scope (returns an instance handle). */
  (): Operation<AgentInstance<I, O>>
  /** Register middleware around the agent's `entry` invocation. */
  decorate(middleware: AgentMiddleware<I, O>): Operation<void>
}

// Convenience re-exports of core tool types used alongside agent authoring.
export type {
  AnyToolFactory,
  InputFromFactory,
  OutputFromFactory,
  ToolMiddleware,
}

export type { AgentCtx, AgentInstance } from './ctx.ts'
