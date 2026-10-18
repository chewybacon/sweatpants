import { useMemo } from "react";
import { createSchemeFlow } from "./scheme-flow.ts";
import { ProgramCanvas } from "./program-canvas.tsx";

export function ProgramPreview({ source }: { source: string }) {
  const plan = useMemo(() => {
    try {
      return {
        value: createSchemeFlow(source),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [source]);
  return (
    <section className="program-preview">
      <details className="logic-plan">
        <summary>{plan.error ? "Source preview" : "Program map"}</summary>
        {plan.error ? (
          <p className="preview-error" role="status">
            Program source cannot be diagrammed: {plan.error}
          </p>
        ) : (
          <>
            {plan.value && <ProgramCanvas key={source} flow={plan.value} />}
            {plan.value?.truncated && (
              <p className="hint">
                Preview limit reached. Additional structure is available in source.
              </p>
            )}
          </>
        )}
      </details>
      <details className="source">
        <summary>Scheme source</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </section>
  );
}
