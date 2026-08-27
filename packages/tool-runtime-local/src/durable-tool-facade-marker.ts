/**
 * Leaf module carrying the durable-facade identity markers so that the
 * facade, the foreign executor, and the invocation runtime can recognize
 * facades without importing each other (cycle-free).
 */
export const DURABLE_TOOL_FACADE_ANNOTATION = "sweatpants/durable-tool-facade";

/** Returns whether a runtime tool carries the durable-facade annotation. */
export function isDurableToolSessionFacade(tool: {
  readonly annotations?: Record<string, unknown>;
}): boolean {
  const annotation = tool.annotations?.[DURABLE_TOOL_FACADE_ANNOTATION];
  return Boolean(annotation && typeof annotation === "object");
}
