/**
 * chat-core/trace-types.ts
 *
 * Pure serializable trace types for tool execution emissions.
 *
 * These types are shared between:
 * - chat-core (replay-types, state, session modules)
 * - framework/browser-rendering (emission runtime)
 * - react-chat (component hydration)
 *
 * They contain no behavioral dependencies — only data interfaces.
 */

export type ComponentTypeLike<TProps = any> =
  | ((props: TProps) => unknown)
  | { displayName?: string | undefined; name?: string | undefined };

/**
 * Component emission payload - used by ctx.render().
 *
 * The _component field is transient (not serialized) but available
 * during execution for immediate rendering.
 */
export interface ComponentEmissionPayload<TProps = Record<string, unknown>> {
  /** Serializable key for component (displayName || name) */
  componentKey: string;

  /** Component props (without RenderableProps) */
  props: TProps;

  /**
   * Transient component reference for immediate rendering.
   * Not serialized - on rehydration, the tool re-runs and provides fresh reference.
   */
  _component?: ComponentTypeLike;
}

/**
 * Trace entry for completed tool message.
 * Fully serializable - no component references.
 */
export interface EmissionTraceEntry {
  /** Derived from array position after normalization/merge. */
  order: number;

  /** Stable browser emission id. */
  emissionId: string;

  /** Source AG-UI interrupt id, when available. */
  sourceInterruptId?: string;

  /** Component key for potential rehydration */
  componentKey: string;

  /** Props that were passed */
  props: Record<string, unknown>;

  /** Response value */
  response?: unknown;

  /** Client wall-clock display/debug metadata; never used as a replay ordering key. */
  timestamp: number;
}

/**
 * Hydrated trace entry for replay.
 * Adds the transient component reference back for UI rendering.
 */
export interface HydratedEmissionTraceEntry extends EmissionTraceEntry {
  _component?: ComponentTypeLike;
}

/**
 * Tool execution trace - included in completed tool messages.
 */
export interface ToolExecutionTrace {
  /** Closed normalized replay trace version. */
  version: 1;

  /** All emissions in canonical array order */
  emissions: EmissionTraceEntry[];

  /** Start timestamp */
  startedAt: number;

  /** End timestamp */
  completedAt: number;
}

/**
 * Tool execution trace with transient component references restored.
 */
export interface HydratedToolExecutionTrace {
  version: 1;
  emissions: HydratedEmissionTraceEntry[];
  startedAt: number;
  completedAt: number;
}
