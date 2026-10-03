import type { NodeRendererDefinition, Processor, ProcessFn, NodeRenderResult } from "./types.ts";
import { getFrameDocument, renderFrameDocument, type RenderNode } from "./document.ts";
import { addTrace, updateBlockById } from "./frame.ts";

/**
 * Render typed syntax data on demand. The pipeline installs the syntax and owns
 * traversal, caching, diagnostics and immutable frame publication. HTML is trusted;
 * escape application data interpolated into output. Thrown errors propagate.
 *
 * @example
 * const citations = defineNodeRenderer({
 *   name: "citations",
 *   syntax: citationSyntax,
 *   *render({ sourceId }) { return yield* renderCitation(sourceId); },
 * });
 * const pipeline = createPipeline({ processors: [markdown, math, citations] });
 */
export function defineNodeRenderer<T>(definition: NodeRendererDefinition<T>): Processor {
  // One erased boundary keeps heterogeneous processor arrays usable. The syntax
  // identity check below ensures callbacks only receive data from their own matcher.
  const renderer = Object.freeze({ ...definition }) as NodeRendererDefinition<unknown>;
  return Object.freeze({
    name: renderer.name,
    ...(renderer.description !== undefined && { description: renderer.description }),
    dependencies: Object.freeze(["markdown"]),
    ...(renderer.preload && { preload: renderer.preload }),
    ...(renderer.isReady && { isReady: renderer.isReady }),
    nodeRenderer: renderer,
    process: createNodeProcess(renderer),
  });
}

function createNodeProcess(renderer: NodeRendererDefinition<unknown>): ProcessFn {
  return function* (frame) {
    let current = frame;
    for (const block of frame.blocks) {
      const document = getFrameDocument(block);
      if (!document) {
        continue;
      }
      let nodes: RenderNode[] | undefined;
      for (const [index, node] of document.nodes.entries()) {
        if (node.syntax !== renderer.syntax || node.settled) {
          continue;
        }
        if (!node.complete && (!renderer.preview || node.rendered !== undefined)) {
          continue;
        }
        const start = Date.now();
        let result: NodeRenderResult;
        if (node.complete) {
          result = yield* renderer.render(node.data);
        } else {
          result = renderer.preview!(node.data);
        }
        const unavailable = typeof result !== "string" && result.status === "unavailable";
        nodes ??= [...document.nodes];
        nodes[index] = {
          ...node,
          ...(typeof result === "string" && { rendered: result }),
          settled: node.complete && !unavailable,
          ...(typeof result !== "string" && result.status === "error" && { error: result.reason }),
        };
        current = addTrace(
          current,
          renderer.name,
          typeof result === "string" ? "update" : unavailable ? "skip" : "error",
          {
            blockId: block.id,
            detail:
              typeof result === "string"
                ? `${node.complete ? "rendered" : "previewed"} ${node.id}`
                : result.reason,
            durationMs: Date.now() - start,
          },
        );
      }
      if (nodes) {
        const updated = { ...document, nodes };
        current = updateBlockById(current, block.id, (prior) => ({
          ...prior,
          meta: { ...prior.meta, document: updated },
          rendered: renderFrameDocument(updated),
        }));
      }
    }
    return current;
  };
}
