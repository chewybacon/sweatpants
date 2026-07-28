/**
 * browser-rendering/emission-helpers.ts
 *
 * Helper functions that create trace entries from emissions.
 * These depend on chat-core trace types but are simple pure functions
 * that framework still needs until state/session modules move.
 */
import type {
  Emission,
  ComponentEmissionPayload,
  EmissionTraceEntry,
  ToolExecutionTrace,
} from "@sweatpants/chat-core";

/**
 * Create a trace entry from an emission.
 */
export function emissionToTraceEntry(
  emission: Emission<ComponentEmissionPayload>,
  order: number,
  sourceInterruptId?: string,
): EmissionTraceEntry {
  return {
    order,
    emissionId: emission.id,
    ...(sourceInterruptId ? { sourceInterruptId } : {}),
    componentKey: emission.payload.componentKey,
    props: emission.payload.props as Record<string, unknown>,
    response: emission.response,
    timestamp: emission.timestamp,
  };
}

/**
 * Create a tool execution trace from a list of emissions.
 */
export function createToolTrace(
  emissions: Emission<ComponentEmissionPayload>[],
  startedAt: number,
  completedAt: number,
  options: { sourceInterruptId?: string } = {},
): ToolExecutionTrace {
  return {
    version: 1,
    emissions: emissions.map((e, i) => emissionToTraceEntry(e, i, options.sourceInterruptId)),
    startedAt,
    completedAt,
  };
}
