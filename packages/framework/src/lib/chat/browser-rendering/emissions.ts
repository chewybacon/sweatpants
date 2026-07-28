/**
 * browser-rendering/emissions.ts
 *
 * Re-exports emission and trace types from @sweatpants/chat-core.
 * The canonical definitions now live there; this file preserves the
 * existing import paths for framework-internal consumers during the
 * dissolution process.
 */
export type {
  ComponentTypeLike,
  ComponentEmissionPayload,
  EmissionTraceEntry,
  HydratedEmissionTraceEntry,
  HydratedToolExecutionTrace,
  ToolExecutionTrace,
  Emission,
  PendingEmission,
  EmissionHandler,
  RuntimeConfig,
  RuntimePrimitive,
} from "@sweatpants/chat-core";

export {
  COMPONENT_EMISSION_TYPE,
  createComponentHandler,
  createRuntime,
  getComponentKey,
} from "@sweatpants/chat-core";

export { emissionToTraceEntry, createToolTrace } from "./emission-helpers.ts";
