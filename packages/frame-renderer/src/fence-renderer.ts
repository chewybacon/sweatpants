import type {
  FenceContent,
  FenceRenderResult,
  FenceRendererDefinition,
  ProcessFn,
  Processor,
} from "./types.ts";
import { addTrace, setBlockRendered, updateBlockById } from "./frame.ts";

const escapeHtml = (source: string): string =>
  source.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

function sourcePreview({ code, language }: FenceContent): string {
  return `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(code)}</code></pre>`;
}

/**
 * Declare a fence renderer. The pipeline owns routing, caching and frame updates.
 * Render callbacks return trusted HTML; escape any untrusted source interpolated into it.
 *
 * @example
 * const diagram = defineFenceRenderer({
 *   name: "diagram",
 *   languages: ["diagram"],
 *   *render({ code, meta }) { return yield* renderDiagram(code, meta); },
 * });
 * const pipeline = createPipeline({ processors: [markdown, shiki, diagram] });
 */
export function defineFenceRenderer(definition: FenceRendererDefinition): Processor {
  const languages =
    definition.languages === "*"
      ? "*"
      : Object.freeze(definition.languages.map((language) => language.toLowerCase()));
  if (
    languages !== "*" &&
    (languages.length === 0 || languages.some((language) => !language || language === "*"))
  ) {
    throw new Error(`Fence renderer '${definition.name}' must declare languages or use "*"`);
  }
  const renderer = Object.freeze({ ...definition, languages });
  return Object.freeze({
    name: renderer.name,
    description: renderer.description,
    dependencies: Object.freeze(["markdown"]),
    preload: renderer.preload,
    isReady: renderer.isReady,
    fenceRenderer: renderer,
    process: createFenceProcess(renderer),
  });
}

/** @internal Bind routing once per pipeline configuration, never globally. */
export function createFenceProcess(
  renderer: FenceRendererDefinition,
  claimedLanguages: ReadonlySet<string> = new Set(),
): ProcessFn {
  return function* (frame) {
    let current = frame;
    for (const block of frame.blocks) {
      if (block.type !== "code") {
        continue;
      }
      const language = (block.language ?? "").toLowerCase();
      if (
        renderer.languages === "*"
          ? claimedLanguages.has(language)
          : !renderer.languages.includes(language)
      ) {
        continue;
      }
      const previous = block.fencePresentation;
      if (
        previous?.renderer === renderer.name &&
        previous.code === block.raw &&
        previous.language === language &&
        previous.meta === block.fenceMeta &&
        previous.status === block.status
      ) {
        continue;
      }

      const content: FenceContent = {
        code: block.raw,
        language,
        meta: block.fenceMeta,
      };
      const start = Date.now();
      const preview = renderer.preview ?? sourcePreview;
      let result: FenceRenderResult;
      if (block.status === "complete") {
        result = yield* renderer.render(content);
      } else {
        result = preview(content);
      }
      const unavailable = typeof result !== "string" && result.status === "unavailable";
      const error =
        typeof result !== "string" && result.status === "error" ? result.reason : undefined;
      const rendered = typeof result === "string" ? result : preview(content);
      current = updateBlockById(current, block.id, (value) => ({
        ...setBlockRendered(
          value,
          rendered,
          block.status === "complete" && !unavailable ? "full" : "quick",
        ),
        ...(!unavailable && {
          fencePresentation: {
            renderer: renderer.name,
            code: block.raw,
            language,
            meta: block.fenceMeta,
            status: block.status,
            error,
          },
        }),
      }));
      current = addTrace(
        current,
        renderer.name,
        error !== undefined ? "error" : unavailable ? "skip" : "update",
        {
          blockId: block.id,
          detail:
            typeof result === "string"
              ? block.status === "complete"
                ? "rendered fence"
                : "source preview"
              : result.reason,
          durationMs: Date.now() - start,
        },
      );
    }
    return current;
  };
}
