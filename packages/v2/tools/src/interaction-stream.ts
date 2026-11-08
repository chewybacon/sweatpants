import type { JournalReader } from "@sweatpan.ts/durable";
import { createJournalTreeStream, type JournalTreeObservation } from "@sweatpan.ts/hosting";
import {
  createPullStream,
  type PullStreamScope,
  type Stream,
  type Subscription,
} from "@sweatpan.ts/runtime";
import type { ToolInteraction, ToolInteractionContract } from "./contracts.ts";

/**
 * Pull-only authored-tool question discovery over persisted owned journals. One owner,
 * one subscription; early owner exit releases traversal. No Guest, producer task,
 * schema execution, answer authority or journal mutation. Reads are separate snapshots.
 * Missing/inconsistent waiting contracts fail the stream; earlier values remain partial.
 * Empty completion means no observed questions, not that all execution has finished.
 *
 * Multiple aliases may share an effect ID only with identical context/response schema
 * references. Conflicting matches reject before emitting that question; the first
 * equivalent declaration is retained. Catalog/objects are trusted assembly and must
 * stay stable during traversal. Visibility, rendering and encoding belong to the caller.
 */
export function createToolInteractionStream<Y>(
  owner: PullStreamScope<Y>,
  root: JournalReader<unknown, unknown, unknown, unknown, unknown, Y>,
  contracts: ReadonlyMap<string, ToolInteractionContract>,
): Stream<ToolInteraction, void, Y> {
  return createPullStream<ToolInteraction, void, Y, Y>(owner, () => {
    let nodes: Subscription<JournalTreeObservation, void, Y> | undefined;
    return function* () {
      nodes ??= yield* createJournalTreeStream(owner, root);
      while (true) {
        const next = yield* nodes.next();
        if (next.done) {
          return { done: true, value: undefined };
        }
        const node = next.value;
        const state = node.state;
        if (state.status !== "running" || state.interaction?.state !== "waiting") {
          continue;
        }
        const pending = state.pending;
        if (!pending || pending.id !== state.interaction.grant.requestId) {
          throw new Error("Registered interaction has no matching pending request");
        }
        const contract = contracts.get(node.program);
        if (!contract || contract.id !== node.program) {
          throw new Error("Unknown interaction program");
        }
        const request = pending.request;
        if (
          !request ||
          typeof request !== "object" ||
          !("effect" in request) ||
          typeof request.effect !== "string" ||
          !("input" in request)
        ) {
          throw new Error("Malformed authored interaction request");
        }
        const matches = Object.values(contract.elicits).filter(
          (effect) => effect.id === request.effect,
        );
        const declaration = matches[0];
        if (!declaration) {
          throw new Error("Undeclared interaction");
        }
        if (
          matches.some(
            (candidate) =>
              candidate.context !== declaration.context ||
              candidate.response !== declaration.response,
          )
        ) {
          throw new Error("Ambiguous interaction declaration");
        }
        return {
          done: false,
          value: {
            execution: node.execution,
            program: node.program,
            parent: node.parent,
            revision: state.revision,
            grant: state.interaction.grant,
            declaration,
            input: request.input,
            scope: pending.scope,
            cancellation: state.cancellation,
            cancellationRequested: state.cancellationRequested,
          },
        };
      }
    };
  });
}
