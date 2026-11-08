import type { Operation } from "@standard-durability/core";
import type { ToolExecution, ToolExecutionResolution } from "./contracts.ts";

/**
 * Resolve one existing direct child to its original tool and answer capabilities.
 * Verify persisted ownership and catalog availability before invoking the application
 * binder, then check its returned identity. No live frontier or Guest is required.
 * The binder is trusted: identity checks cannot prove where its methods send writes.
 *
 * This does not authorize a caller, validate an answer, reserve resolution authority,
 * drive work or supply a generic writable-child opener. Reads are separate snapshots.
 * Re-resolve through fresh connection-bound wiring after reopening storage.
 */
export function* resolveToolExecution<Tool extends { readonly id: string }, E, Y>(
  resolution: ToolExecutionResolution<Tool, E, Y>,
  execution: string,
): Operation<ToolExecution<Tool, E, Y>, Y> {
  const reader = yield* resolution.owner.openChild(execution);
  const persisted = yield* reader.read();
  const tool = resolution.programs.get(persisted.program);
  if (!tool || tool.id !== persisted.program) {
    throw new Error("Pinned tool is unavailable");
  }
  const child = yield* resolution.bind(execution, persisted.program);
  if (
    child.journal.id !== execution ||
    child.link.childId !== execution ||
    child.link.parentId !== resolution.owner.id ||
    child.link.program !== persisted.program
  ) {
    throw new Error("Resolved tool execution does not match persisted ownership");
  }
  return {
    execution,
    tool,
    interactions: {
      request: child.journal.interactions.request,
      answer: child.journal.interactions.answer,
    },
  };
}
